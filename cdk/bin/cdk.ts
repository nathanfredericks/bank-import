#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as path from "path";

const app = new cdk.App();
const stack = new cdk.Stack(app, "BankImportStack");

const vpc = new ec2.Vpc(stack, "BankImportVpc", {
  natGateways: 0,
});

const tracesBucket = new s3.Bucket(stack, "BankImportTracesBucket", {
  bucketName: "bank-import-traces",
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

const secretArn = `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:BankImport-OADlWd`;

const taskDefinition = new ecs.FargateTaskDefinition(stack, "Bank", {
  memoryLimitMiB: 2048,
  cpu: 1024,
  runtimePlatform: {
    cpuArchitecture: ecs.CpuArchitecture.ARM64,
    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
  },
});

taskDefinition.addContainer("bank-import", {
  image: ecs.ContainerImage.fromAsset(path.resolve(__dirname, "../..")),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: "ecs",
    logGroup,
    mode: ecs.AwsLogDriverMode.NON_BLOCKING,
    maxBufferSize: cdk.Size.mebibytes(25),
  }),
  environment: {
    AWS_S3_BUCKET_NAME: tracesBucket.bucketName,
    DEBUG: String(false),
    JMAP_SESSION_URL: "https://api.fastmail.com/jmap/session",
    TZ: "America/Halifax",
    UUID_NAMESPACE: "dd1c0381-ed5b-4009-9dc3-83da67d9f339",
    YNAB_BUDGET_ID: "e0e7f122-6f2f-41f3-9b84-6d8f49fd5eab",
    SECRET_NAME: secretArn,
  },
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
  "rate(4 hours)",
  "America/Halifax",
);

createBankSchedule(
  "BankImportRogersBankSchedule",
  "rogers-bank",
  "rate(4 hours)",
  "America/Halifax",
);

createBankSchedule(
  "BankImportNBDBSchedule",
  "nbdb",
  "cron(0 16 ? * MON-FRI *)",
  "America/New_York",
);
