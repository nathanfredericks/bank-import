import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import path from "node:path";

export const ACCOUNT = "187489282488";
export const REGION = "ca-central-1";
export const BANKS = ["rogers-bank", "nbdb"] as const;

export function parseBankList(value: unknown): string[] {
  if (value === undefined || value === "") return [];
  const banks = typeof value === "string" ? value.split(",") : value;
  if (
    !Array.isArray(banks) ||
    banks.some((b) => !BANKS.includes(b)) ||
    new Set(banks).size !== banks.length
  )
    throw new Error(
      "Bank list must contain only unique rogers-bank and nbdb entries",
    );
  return banks;
}

export function buildStack(app: cdk.App) {
  const enabled = parseBankList(app.node.tryGetContext("enabledBanks"));
  const verified = parseBankList(app.node.tryGetContext("verifiedBanks"));
  if (enabled.some((bank) => !verified.includes(bank)))
    throw new Error(
      "Enable schedules only after email, dry-run, and live-import verification; supply verifiedBanks",
    );
  const stack = new cdk.Stack(app, "BankImportStack", {
    env: { account: ACCOUNT, region: REGION },
  });
  const parameter = (name: string) =>
    ssm.StringParameter.valueForStringParameter(stack, `/bank-import/${name}`);
  const timezone = parameter("timezone");
  const secretArn = parameter("secret-arn");
  const secret = secretsmanager.Secret.fromSecretCompleteArn(
    stack,
    "BankImportSecret",
    secretArn,
  );
  const traces = new s3.Bucket(stack, "BankImportTracesBucket", {
    bucketName: parameter("traces-bucket-name"),
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
  });
  const vpc = new ec2.Vpc(stack, "BankImportVpc", {
    availabilityZones: ["ca-central-1a", "ca-central-1b"],
    natGateways: 0,
    subnetConfiguration: [
      { name: "public", subnetType: ec2.SubnetType.PUBLIC },
    ],
  });
  const securityGroup = new ec2.SecurityGroup(
    stack,
    "BankImportTaskSecurityGroup",
    { vpc, allowAllOutbound: true },
  );
  const cluster = new ecs.Cluster(stack, "BankImportCluster", { vpc });
  const logGroup = new logs.LogGroup(stack, "BankImportLogGroup", {
    logGroupName: "/ecs/BankImport",
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const image = ecs.ContainerImage.fromAsset(path.resolve(__dirname, "../.."), {
    platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
    exclude: [
      ".git",
      "**/node_modules",
      "**/cdk.out",
      ".env",
      ".env.*",
      "cdk",
      "traces",
      "tests",
      "user-data",
    ],
    ignoreMode: cdk.IgnoreMode.GLOB,
  });
  const scheduleGroup = new scheduler.CfnScheduleGroup(stack, "Schedules", {
    name: "bank-import",
  });
  const common = {
    TZ: timezone,
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
    YNAB_BUDGET_ID: parameter("ynab-budget-id"),
    AWS_SECRET_ARN: secretArn,
    AWS_S3_TRACES_BUCKET_NAME: traces.bucketName,
    // Manual launches must explicitly override to false after reviewing their preview.
    DRY_RUN: "true",
  };
  for (const bank of BANKS) {
    const name = bank === "nbdb" ? "NBDB" : "RogersBank";
    const task = new ecs.FargateTaskDefinition(
      stack,
      `BankImportTaskDefinition-${name}`,
      {
        cpu: 1024,
        memoryLimitMiB: 2048,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      },
    );
    task.addContainer("bank-import", {
      image,
      essential: true,
      stopTimeout: cdk.Duration.seconds(119),
      linuxParameters: new ecs.LinuxParameters(stack, `Init-${name}`, {
        initProcessEnabled: true,
      }),
      environment: {
        ...common,
        BANK: bank,
        ...(bank === "nbdb"
          ? {
              YNAB_ADJUSTMENT_PAYEE_ID: parameter("ynab-adjustment-payee-id"),
              NBDB_EXCLUDED_ACCOUNT_IDS: parameter("nbdb-excluded-account-ids"),
            }
          : {
              ROGERS_EMAIL_SENDER: parameter("rogers-email-sender"),
              ROGERS_EMAIL_SUBJECT: parameter("rogers-email-subject"),
              ROGERS_EMAIL_CODE_LENGTH: parameter("rogers-email-code-length"),
            }),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: bank,
        logGroup,
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        maxBufferSize: cdk.Size.mebibytes(25),
      }),
    });
    task.addContainer("timeout", {
      // Reuse the private ECR asset: no public-registry pull at task startup.
      image,
      entryPoint: ["sh", "-c"],
      command: ["sleep 300; exit 1"],
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `watchdog-${bank}`,
        logGroup,
      }),
    });
    traces.grantPut(task.taskRole);
    secret.grantRead(task.taskRole);
    const role = new iam.Role(
      stack,
      `BankImportSchedulerExecutionRole-${name}`,
      {
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      },
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [task.taskDefinitionArn],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [task.taskRole.roleArn, task.executionRole!.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
        },
      }),
    );
    const schedule = new scheduler.CfnSchedule(
      stack,
      `BankImportSchedule-${name}`,
      {
        groupName: scheduleGroup.ref,
        name: `bank-import-${bank}`,
        state: enabled.includes(bank) ? "ENABLED" : "DISABLED",
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression:
          bank === "nbdb" ? "cron(10 0/4 * * ? *)" : "cron(0 0/4 * * ? *)",
        scheduleExpressionTimezone: timezone,
        target: {
          arn: cluster.clusterArn,
          roleArn: role.roleArn,
          // Avoid retries producing overlapping bank logins or balance adjustments.
          retryPolicy: {
            maximumRetryAttempts: 0,
            maximumEventAgeInSeconds: 60,
          },
          input: JSON.stringify({
            containerOverrides: [
              {
                name: "bank-import",
                environment: [{ name: "DRY_RUN", value: "false" }],
              },
            ],
          }),
          ecsParameters: {
            taskDefinitionArn: task.taskDefinitionArn,
            launchType: "FARGATE",
            platformVersion: "1.4.0",
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: vpc.publicSubnets.map((subnet) => subnet.subnetId),
                securityGroups: [securityGroup.securityGroupId],
                assignPublicIp: "ENABLED",
              },
            },
          },
        },
      },
    );
    new cdk.CfnOutput(stack, `${name}TaskDefinitionArn`, {
      value: task.taskDefinitionArn,
    });
    new cdk.CfnOutput(stack, `${name}ScheduleName`, { value: schedule.ref });
  }
  for (const [id, value] of Object.entries({
    ClusterArn: cluster.clusterArn,
    SubnetIds: vpc.publicSubnets.map((s) => s.subnetId).join(","),
    SecurityGroupId: securityGroup.securityGroupId,
    LogGroupName: logGroup.logGroupName,
    TracesBucketName: traces.bucketName,
    ScheduleGroupName: scheduleGroup.ref,
  }))
    new cdk.CfnOutput(stack, id, { value });
  return stack;
}
