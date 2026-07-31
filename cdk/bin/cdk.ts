#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import path from "path";

const app = new cdk.App();
const stack = new cdk.Stack(app, "BankImportStack");

const tracesBucketName = ssm.StringParameter.valueForStringParameter(
  stack,
  "/bank-import/traces-bucket-name",
);

const timezone = ssm.StringParameter.valueForStringParameter(
  stack,
  "/bank-import/timezone",
);

// const tailscaleExitNode = ssm.StringParameter.valueForStringParameter(
//   stack,
//   "/bank-import/tailscale-exit-node",
// );

const ynabBudgetId = ssm.StringParameter.valueForStringParameter(
  stack,
  "/bank-import/ynab-budget-id",
);

const messagesTableName = ssm.StringParameter.valueForStringParameter(
  stack,
  "/bank-import/messages-table-name",
);

const secretArn = ssm.StringParameter.valueForStringParameter(
  stack,
  "/bank-import/secret-arn",
);

const vpc = new ec2.Vpc(stack, "BankImportVpc", {
  natGateways: 0,
});

const tracesBucket = new s3.Bucket(stack, "BankImportTracesBucket", {
  bucketName: tracesBucketName,
  versioned: false,
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  lifecycleRules: [
    {
      id: "DeleteAfter7Days",
      enabled: true,
      expiration: cdk.Duration.days(7),
    },
  ],
});

const sessionStateKey = new kms.Key(stack, "BankImportSessionStateKey", {
  enableKeyRotation: true,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

const sessionStateBucket = new s3.Bucket(
  stack,
  "BankImportSessionStateBucket",
  {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: sessionStateKey,
    versioned: false,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  },
);

const authSessions = new dynamodb.Table(stack, "BankImportAuthSessions", {
  partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
  timeToLiveAttribute: "ttl",
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
authSessions.addGlobalSecondaryIndex({
  indexName: "tokenHash-index",
  partitionKey: { name: "tokenHash", type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

const cluster = new ecs.Cluster(stack, "BankImportCluster", {
  vpc,
});

const logGroup = new logs.LogGroup(stack, "BankImportLogGroup", {
  logGroupName: "/ecs/BankImport",
  retention: logs.RetentionDays.ONE_WEEK,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

const bankImportSecret = secretsmanager.Secret.fromSecretCompleteArn(
  stack,
  "BankImportSecret",
  secretArn,
);

const taskSecurityGroup = new ec2.SecurityGroup(
  stack,
  "BankImportTaskSecurityGroup",
  {
    vpc,
    allowAllOutbound: true,
  },
);

const workerImage = ecs.ContainerImage.fromAsset(
  path.resolve(__dirname, "../.."),
  {
    platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
  },
);

const recoveryTaskDefinition = new ecs.FargateTaskDefinition(
  stack,
  "BankImportRecoveryTaskDefinition",
  {
    memoryLimitMiB: 2048,
    cpu: 1024,
    runtimePlatform: {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    },
  },
);
const recoveryContainer = recoveryTaskDefinition.addContainer("bank-import", {
  image: workerImage,
  // Fargate permits at most 120 seconds for graceful container shutdown.
  // The reconnect workflow itself remains active for up to ten minutes.
  stopTimeout: cdk.Duration.seconds(119),
  environment: {
    TZ: timezone,
    YNAB_BUDGET_ID: ynabBudgetId,
    AWS_S3_TRACES_BUCKET_NAME: tracesBucket.bucketName,
    AWS_S3_SESSION_STATES_BUCKET_NAME: sessionStateBucket.bucketName,
    AWS_SECRET_ARN: secretArn,
    AWS_DYNAMODB_MESSAGES_TABLE_NAME: messagesTableName,
    AUTH_SESSIONS_TABLE_NAME: authSessions.tableName,
  },
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: "auth-recovery", logGroup }),
});

tracesBucket.grantPut(recoveryTaskDefinition.taskRole);
sessionStateBucket.grantReadWrite(recoveryTaskDefinition.taskRole);
authSessions.grantReadWriteData(recoveryTaskDefinition.taskRole);
bankImportSecret.grantRead(recoveryTaskDefinition.taskRole);
recoveryTaskDefinition.addToTaskRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["dynamodb:Scan", "dynamodb:DeleteItem"],
    resources: [
      `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${messagesTableName}`,
    ],
  }),
);

const authHandler = new lambda.Function(stack, "BankImportAuthHandler", {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset(path.resolve(__dirname, "../../lambda/auth")),
  timeout: cdk.Duration.seconds(15),
  memorySize: 256,
  environment: {
    AUTH_SESSIONS_TABLE_NAME: authSessions.tableName,
    AUTH_ECS_CLUSTER_ARN: cluster.clusterArn,
    AUTH_WORKER_TASK_DEFINITION_ARN: recoveryTaskDefinition.taskDefinitionArn,
    AUTH_WORKER_SUBNET_IDS: vpc.publicSubnets
      .map((subnet) => subnet.subnetId)
      .join(","),
    AUTH_WORKER_SECURITY_GROUP_IDS: taskSecurityGroup.securityGroupId,
    AUTH_WEBSOCKET_STAGE: "$default",
  },
});
authSessions.grantReadWriteData(authHandler);
authHandler.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["ecs:RunTask"],
    resources: [recoveryTaskDefinition.taskDefinitionArn],
  }),
);
authHandler.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["iam:PassRole"],
    resources: [
      recoveryTaskDefinition.taskRole.roleArn,
      recoveryTaskDefinition.executionRole!.roleArn,
    ],
  }),
);

const controlApi = new apigwv2.WebSocketApi(stack, "BankImportAuthControlApi", {
  connectRouteOptions: {
    integration: new apigwv2Integrations.WebSocketLambdaIntegration(
      "ConnectIntegration",
      authHandler,
    ),
  },
  disconnectRouteOptions: {
    integration: new apigwv2Integrations.WebSocketLambdaIntegration(
      "DisconnectIntegration",
      authHandler,
    ),
  },
});
const controlStage = new apigwv2.WebSocketStage(
  stack,
  "BankImportAuthControlStage",
  {
    webSocketApi: controlApi,
    stageName: "$default",
    autoDeploy: true,
  },
);
authHandler.addEnvironment("AUTH_WEBSOCKET_API_ID", controlApi.apiId);
authHandler.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["execute-api:ManageConnections"],
    resources: ["*"],
  }),
);

const portalApi = new apigwv2.HttpApi(stack, "BankImportAuthPortalApi");
const portalIntegration = new apigwv2Integrations.HttpLambdaIntegration(
  "PortalIntegration",
  authHandler,
);
portalApi.addRoutes({
  path: "/",
  methods: [apigwv2.HttpMethod.ANY],
  integration: portalIntegration,
});
portalApi.addRoutes({
  path: "/{proxy+}",
  methods: [apigwv2.HttpMethod.ANY],
  integration: portalIntegration,
});
const portalDomain = new apigwv2.DomainName(
  stack,
  "BankImportAuthPortalDomain",
  {
    domainName: "reconnect.fredericks.app",
    certificate: acm.Certificate.fromCertificateArn(
      stack,
      "BankImportAuthPortalCertificate",
      "arn:aws:acm:ca-central-1:187489282488:certificate/c2eaab2f-e440-424d-adbe-dc7f7127d03d",
    ),
  },
);
new apigwv2.ApiMapping(stack, "BankImportAuthPortalMapping", {
  api: portalApi,
  domainName: portalDomain,
});
const authPortalUrl = "https://reconnect.fredericks.app";
recoveryContainer.addEnvironment("AUTH_PORTAL_URL", authPortalUrl);
recoveryContainer.addEnvironment(
  "AUTH_CONTROL_WEBSOCKET_URL",
  controlStage.url,
);
new cdk.CfnOutput(stack, "AuthPortalUrl", { value: authPortalUrl });

function createBankSchedule(
  id: string,
  bankName: string,
  scheduleExpression: string,
  scheduleTimezone: string,
) {
  const taskDefinition = new ecs.FargateTaskDefinition(
    stack,
    `BankImportTaskDefinition-${bankName}`,
    {
      memoryLimitMiB: 2048,
      cpu: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    },
  );

  // const tailscaleContainer = taskDefinition.addContainer("tailscale", {
  //   image: ecs.ContainerImage.fromRegistry("tailscale/tailscale:latest"),
  //   stopTimeout: cdk.Duration.minutes(2),
  //   secrets: {
  //     TS_AUTHKEY: ecs.Secret.fromSecretsManager(
  //       bankImportSecret,
  //       "TAILSCALE_AUTH_KEY",
  //     ),
  //   },
  //   environment: {
  //     TS_EXTRA_ARGS: `--advertise-tags=tag:container --exit-node=${tailscaleExitNode}`,
  //     TS_OUTBOUND_HTTP_PROXY_LISTEN: ":1055",
  //     TS_ENABLE_HEALTH_CHECK: "true",
  //     TS_LOCAL_ADDR_PORT: "127.0.0.1:9002",
  //   },
  //   healthCheck: {
  //     command: [
  //       "CMD-SHELL",
  //       "wget -q --spider http://127.0.0.1:9002/healthz || exit 1",
  //     ],
  //     interval: cdk.Duration.seconds(10),
  //     retries: 5,
  //     startPeriod: cdk.Duration.seconds(10),
  //     timeout: cdk.Duration.seconds(5),
  //   },
  // });

  const bankImportContainer = taskDefinition.addContainer("bank-import", {
    image: workerImage,
    stopTimeout: cdk.Duration.minutes(2),
    environment: {
      BANK: id,
      TZ: timezone,
      YNAB_BUDGET_ID: ynabBudgetId,
      AWS_S3_TRACES_BUCKET_NAME: tracesBucket.bucketName,
      AWS_S3_SESSION_STATES_BUCKET_NAME: sessionStateBucket.bucketName,
      AWS_SECRET_ARN: secretArn,
      AWS_DYNAMODB_MESSAGES_TABLE_NAME: messagesTableName,
      AUTH_SESSIONS_TABLE_NAME: authSessions.tableName,
      AUTH_PORTAL_URL: authPortalUrl,
      AUTH_CONTROL_WEBSOCKET_URL: controlStage.url,
      // HTTP_PROXY: "http://localhost:1055",
    },
    logging: ecs.LogDrivers.awsLogs({
      streamPrefix: id,
      logGroup,
      mode: ecs.AwsLogDriverMode.NON_BLOCKING,
      maxBufferSize: cdk.Size.mebibytes(25),
    }),
    essential: true,
  });

  taskDefinition.addContainer("timeout", {
    image: ecs.ContainerImage.fromRegistry(
      "public.ecr.aws/docker/library/alpine:latest",
    ),
    command: ["sh", "-c", "sleep 660"],
    essential: true,
  });

  // bankImportContainer.addContainerDependencies({
  //   container: tailscaleContainer,
  //   condition: ecs.ContainerDependencyCondition.HEALTHY,
  // });

  taskDefinition.addToTaskRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["s3:PutObject"],
      resources: [tracesBucket.arnForObjects("*")],
    }),
  );

  sessionStateBucket.grantReadWrite(taskDefinition.taskRole);
  authSessions.grantReadWriteData(taskDefinition.taskRole);

  taskDefinition.addToTaskRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: [secretArn],
    }),
  );

  taskDefinition.addToTaskRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:Scan", "dynamodb:DeleteItem"],
      resources: [
        `arn:aws:dynamodb:${stack.region}:${stack.account}:table/${messagesTableName}`,
      ],
    }),
  );

  taskDefinition.addToTaskRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ssm:GetParameter"],
      resources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter/bank-import/*`,
      ],
    }),
  );

  const schedulerRole = new iam.Role(
    stack,
    `BankImportSchedulerExecutionRole-${bankName}`,
    {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      inlinePolicies: {
        ECSTaskExecution: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ecs:RunTask"],
              resources: [
                taskDefinition.taskDefinitionArn,
                `arn:aws:ecs:${stack.region}:${stack.account}:task/${cluster.clusterName}/*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["iam:PassRole"],
              resources: [
                taskDefinition.taskRole.roleArn,
                taskDefinition.executionRole!.roleArn,
              ],
            }),
          ],
        }),
      },
    },
  );

  new scheduler.CfnSchedule(stack, `BankImportSchedule-${bankName}`, {
    flexibleTimeWindow: {
      mode: "OFF",
    },
    state: "DISABLED",
    scheduleExpression,
    scheduleExpressionTimezone: scheduleTimezone,
    target: {
      arn: cluster.clusterArn,
      roleArn: schedulerRole.roleArn,
      ecsParameters: {
        taskDefinitionArn: taskDefinition.taskDefinitionArn,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: vpc.publicSubnets.map(
              (subnet: ec2.ISubnet) => subnet.subnetId,
            ),
            securityGroups: [taskSecurityGroup.securityGroupId],
            assignPublicIp: "ENABLED",
          },
        },
      },
    },
  });
}

createBankSchedule("bmo", "BMO", "cron(0 0/4 * * ? *)", timezone);

createBankSchedule(
  "rogers-bank",
  "RogersBank",
  "cron(0 0/4 * * ? *)",
  timezone,
);

// createBankSchedule("tangerine", "Tangerine", "cron(0 0/4 * * ? *)", timezone);

createBankSchedule(
  "nbdb",
  "NBDB",
  "cron(0 16 ? * MON-FRI *)",
  "America/New_York",
);
