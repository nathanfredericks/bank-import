#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
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

const tailscaleExitNode = ssm.StringParameter.valueForStringParameter(
  stack,
  "/bank-import/tailscale-exit-node",
);

const ynabBudgetId = ssm.StringParameter.valueForStringParameter(
  stack,
  "/bank-import/ynab-budget-id",
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
  lifecycleRules: [
    {
      id: "DeleteAfter7Days",
      enabled: true,
      expiration: cdk.Duration.days(7),
    },
  ],
});

const cluster = new ecs.Cluster(stack, "BankImportCluster", {
  vpc,
});

const logGroup = new logs.LogGroup(stack, "BankImportLogGroup", {
  logGroupName: "/ecs/Bank",
  retention: logs.RetentionDays.ONE_WEEK,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

const bankImportSecret = secretsmanager.Secret.fromSecretCompleteArn(
  stack,
  "BankImportSecret",
  secretArn,
);

const taskDefinition = new ecs.FargateTaskDefinition(stack, "Bank", {
  memoryLimitMiB: 2048,
  cpu: 1024,
  runtimePlatform: {
    cpuArchitecture: ecs.CpuArchitecture.ARM64,
    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
  },
});

const tailscaleContainer = taskDefinition.addContainer("tailscale", {
  image: ecs.ContainerImage.fromRegistry("tailscale/tailscale:latest"),
  stopTimeout: cdk.Duration.minutes(2),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: "ecs",
    logGroup,
    mode: ecs.AwsLogDriverMode.NON_BLOCKING,
    maxBufferSize: cdk.Size.mebibytes(25),
  }),
  secrets: {
    TS_AUTHKEY: ecs.Secret.fromSecretsManager(
      bankImportSecret,
      "TAILSCALE_AUTH_KEY",
    ),
  },
  environment: {
    TS_EXTRA_ARGS: `--advertise-tags=tag:container --exit-node=${tailscaleExitNode}`,
    TS_OUTBOUND_HTTP_PROXY_LISTEN: ":1055",
    TS_ENABLE_HEALTH_CHECK: "true",
    TS_LOCAL_ADDR_PORT: "127.0.0.1:9002",
  },
  healthCheck: {
    command: [
      "CMD-SHELL",
      "wget -q --spider http://127.0.0.1:9002/healthz || exit 1",
    ],
    interval: cdk.Duration.seconds(10),
    retries: 5,
    startPeriod: cdk.Duration.seconds(10),
    timeout: cdk.Duration.seconds(5),
  },
});

const bankImportContainer = taskDefinition.addContainer("bank-import", {
  image: ecs.ContainerImage.fromAsset(path.resolve(__dirname, "../.."), {
    platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
  }),
  stopTimeout: cdk.Duration.minutes(2),
  environment: {
    TZ: timezone,
    YNAB_BUDGET_ID: ynabBudgetId,
    AWS_S3_TRACES_BUCKET_NAME: tracesBucket.bucketName,
    AWS_SECRET_ARN: secretArn,
    HTTP_PROXY: "http://localhost:1055",
  },
});

bankImportContainer.addContainerDependencies({
  container: tailscaleContainer,
  condition: ecs.ContainerDependencyCondition.HEALTHY,
});

taskDefinition.addToTaskRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["s3:PutObject"],
    resources: [tracesBucket.arnForObjects("*")],
  }),
);

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
    actions: ["ssm:GetParameter"],
    resources: [
      `arn:aws:ssm:${stack.region}:${stack.account}:parameter/bank-import/*`,
    ],
  }),
);

const taskSecurityGroup = new ec2.SecurityGroup(
  stack,
  "BankTaskSecurityGroup",
  {
    vpc,
    allowAllOutbound: true,
  },
);

const schedulerRole = new iam.Role(stack, "BankImportSchedulerExecutionRole", {
  assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
  inlinePolicies: {
    ECSTaskExecution: new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ecs:RunTask", "ecs:TagResource"],
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
});

function createBankSchedule(
  id: string,
  bankName: string,
  scheduleExpression: string,
  timezone: string,
): scheduler.CfnSchedule {
  return new scheduler.CfnSchedule(stack, id, {
    flexibleTimeWindow: {
      mode: "OFF",
    },
    scheduleExpression,
    scheduleExpressionTimezone: timezone,
    target: {
      arn: cluster.clusterArn,
      roleArn: schedulerRole.roleArn,
      ecsParameters: {
        taskDefinitionArn: taskDefinition.taskDefinitionArn,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: vpc.publicSubnets.map((subnet) => subnet.subnetId),
            securityGroups: [taskSecurityGroup.securityGroupId],
            assignPublicIp: "ENABLED",
          },
        },
      },
      input: JSON.stringify({
        containerOverrides: [
          {
            name: "bank-import",
            environment: [
              {
                name: "BANK",
                value: bankName,
              },
            ],
          },
        ],
      }),
    },
  });
}

createBankSchedule(
  "BankImportBMOSchedule",
  "bmo",
  "cron(0 0/4 * * ? *)",
  timezone,
);

createBankSchedule(
  "BankImportRogersBankSchedule",
  "rogers-bank",
  "cron(0 0/4 * * ? *)",
  timezone,
);

createBankSchedule(
  "BankImportNBDBSchedule",
  "nbdb",
  "cron(0 16 ? * MON-FRI *)",
  "America/New_York",
);
