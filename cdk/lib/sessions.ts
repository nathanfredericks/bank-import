import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

export function sessionResources(stack: cdk.Stack) {
  const bucket = new s3.Bucket(stack, "SessionBucket", {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const table = new dynamodb.Table(stack, "Sessions", {
    partitionKey: { name: "key", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  return { bucket, table };
}
export function sessionLambda(
  stack: cdk.Stack,
  bank: string,
  task: ecs.FargateTaskDefinition,
  bucket: s3.IBucket,
  table: dynamodb.ITable,
  environment: Record<string, string>,
) {
  const root = path.resolve(__dirname, "../..");
  const {
    AWS_REGION: _region,
    AWS_DEFAULT_REGION: _defaultRegion,
    ...lambdaEnvironment
  } = environment;
  const fn = new lambda.Function(stack, `SessionLambda-${bank}`, {
    functionName: `bank-import-session-${bank}`,
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: "index.handler",
    timeout: cdk.Duration.seconds(180),
    memorySize: 1024,
    loggingFormat: lambda.LoggingFormat.JSON,
    logRetention: logs.RetentionDays.ONE_WEEK,
    environment: {
      ...lambdaEnvironment,
      BANK: bank,
      SESSION_BUCKET: bucket.bucketName,
      SESSION_TABLE: table.tableName,
      ...(bank === "eq-bank"
        ? { EQ_STATE_BUCKET: bucket.bucketName, EQ_JOB_ID: "lambda" }
        : {}),
    },
    code: lambda.Code.fromAsset(root, {
      exclude: [
        ".git",
        "node_modules",
        "cdk",
        "dist",
        ".env*",
        "user-data",
        "traces",
        "tests",
      ],
      bundling: {
        image: lambda.Runtime.NODEJS_24_X.bundlingImage,
        local: {
          tryBundle(outputDir: string) {
            execFileSync(
              "bun",
              [
                "build",
                "src/sessions/handler.ts",
                "--target=node",
                "--external",
                "playwright-core",
                "--outfile",
                path.join(outputDir, "index.mjs"),
              ],
              { cwd: root, stdio: "pipe" },
            );
            mkdirSync(path.join(outputDir, "node_modules"), {
              recursive: true,
            });
            cpSync(
              path.join(root, "node_modules/playwright-core"),
              path.join(outputDir, "node_modules/playwright-core"),
              { recursive: true },
            );
            execFileSync(
              "node",
              ["--check", path.join(outputDir, "index.mjs")],
              { stdio: "pipe" },
            );
            return true;
          },
        },
      },
    }),
  });
  bucket.grantReadWrite(fn);
  table.grantReadWriteData(fn);
  bucket.grantReadWrite(task.taskRole);
  table.grantReadWriteData(task.taskRole);
  task.defaultContainer!.addEnvironment("SESSION_BUCKET", bucket.bucketName);
  task.defaultContainer!.addEnvironment("SESSION_TABLE", table.tableName);
  task.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
      resources: ["*"],
    }),
  );
  const policy = new ssm.StringParameter(stack, `SessionPolicy-${bank}`, {
    parameterName: `/bank-import/sessions/${bank}`,
    stringValue: JSON.stringify({
      direct: false,
      renew: false,
      maintenance: false,
    }),
  });
  policy.grantRead(fn);
  return fn;
}
export function maintenanceSchedule(
  stack: cdk.Stack,
  bank: string,
  fn: lambda.Function,
  workflowArn: string,
  group: scheduler.CfnScheduleGroup,
  enabled: boolean,
) {
  // A literal ARN avoids Lambda -> workflow -> Lambda CloudFormation cycles.
  const targetArn = stack.formatArn({
    service: "states",
    resource: "stateMachine",
    resourceName: bank === "eq-bank" ? "bank-import-eq" : `bank-import-${bank}`,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
  fn.addEnvironment("SESSION_WORKFLOW_ARN", targetArn);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["states:StartExecution"],
      resources: [targetArn],
    }),
  );
  const role = new iam.Role(stack, `SessionMaintenanceRole-${bank}`, {
    assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
  });
  fn.grantInvoke(role);
  new scheduler.CfnSchedule(stack, `SessionMaintenance-${bank}`, {
    name: `bank-import-session-${bank}`,
    groupName: group.ref,
    state: enabled ? "ENABLED" : "DISABLED",
    scheduleExpression: "rate(1 minute)",
    flexibleTimeWindow: { mode: "OFF" },
    target: {
      arn: fn.functionArn,
      roleArn: role.roleArn,
      input: JSON.stringify({ action: "maintain" }),
      retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
    },
  });
}
export function browserTask(
  task: ecs.FargateTaskDefinition,
  cluster: ecs.Cluster,
  vpc: ec2.Vpc,
  sg: ec2.SecurityGroup,
  eq = false,
) {
  return {
    Type: "Task",
    Resource: "arn:aws:states:::ecs:runTask.waitForTaskToken",
    TimeoutSeconds: 480,
    Parameters: {
      Cluster: cluster.clusterArn,
      TaskDefinition: task.taskDefinitionArn,
      LaunchType: "FARGATE",
      PlatformVersion: "1.4.0",
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          Subnets: vpc.publicSubnets.map((s) => s.subnetId),
          SecurityGroups: [sg.securityGroupId],
          AssignPublicIp: "ENABLED",
        },
      },
      Overrides: {
        ContainerOverrides: [
          {
            Name: "bank-import",
            Environment: [
              { Name: "BANK_JOB_ID", "Value.$": "$.job.jobId" },
              { Name: "BANK_REQUEST_ID", "Value.$": "$.job.requestId" },
              { Name: "BANK_TASK_TOKEN", "Value.$": "$$.Task.Token" },
              {
                Name: "BANK_FORCE_LOGIN",
                "Value.$": "States.JsonToString($.api.forceLogin)",
              },
              {
                Name: "DRY_RUN",
                "Value.$": "States.JsonToString($.job.dryRun)",
              },
              ...(eq ? [{ Name: "EQ_JOB_ID", "Value.$": "$.job.jobId" }] : []),
            ],
          },
        ],
      },
    },
    ResultPath: "$.worker",
    Catch: [
      { ErrorEquals: ["States.ALL"], ResultPath: "$.failure", Next: "FailJob" },
    ],
    Next: "ProcessResult",
  };
}
export function bankWorkflow(
  stack: cdk.Stack,
  bank: string,
  fn: lambda.Function,
  task: ecs.FargateTaskDefinition,
  cluster: ecs.Cluster,
  vpc: ec2.Vpc,
  sg: ec2.SecurityGroup,
) {
  const role = new iam.Role(stack, `SessionWorkflowRole-${bank}`, {
    assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
  });
  fn.grantInvoke(role);
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
  const fail = [
    { ErrorEquals: ["States.ALL"], ResultPath: "$.failure", Next: "FailJob" },
  ];
  const call = (action: string, next: string, result: string) => ({
    Type: "Task",
    Resource: fn.functionArn,
    Parameters: { action, "job.$": "$.job" },
    ResultPath: result,
    Catch: fail,
    Next: next,
  });
  const workflow = new sfn.CfnStateMachine(stack, `SessionWorkflow-${bank}`, {
    stateMachineName: `bank-import-${bank}`,
    roleArn: role.roleArn,
    definitionString: stack.toJsonString({
      StartAt: "Initialize",
      TimeoutSeconds: 1200,
      States: {
        Initialize: {
          Type: "Pass",
          Parameters: { "job.$": "$" },
          Next: "Prepare",
        },
        Prepare: {
          Type: "Task",
          Resource: fn.functionArn,
          Parameters: {
            action: "prepare",
            "job.$": "$.job",
            "execution.$": "$$.Execution.Name",
          },
          ResultPath: "$.control",
          Next: "Lease",
        },
        Lease: {
          Type: "Choice",
          Choices: [
            { Variable: "$.control.done", BooleanEquals: true, Next: "Done" },
            {
              Variable: "$.control.blocked",
              BooleanEquals: true,
              Next: "Blocked",
            },
            {
              Variable: "$.control.acquired",
              BooleanEquals: true,
              Next: "AdoptJob",
            },
          ],
          Default: "WaitForLease",
        },
        WaitForLease: { Type: "Wait", Seconds: 5, Next: "Prepare" },
        AdoptJob: {
          Type: "Pass",
          Parameters: { "job.$": "$.control.job" },
          Next: "TryAPI",
        },
        TryAPI: call("fetch", "APIAvailable", "$.api"),
        APIAvailable: {
          Type: "Choice",
          Choices: [
            {
              Variable: "$.api.outcome",
              StringEquals: "authentication-required",
              Next: "RunBankWorker",
            },
          ],
          Default: "ProcessResult",
        },
        RunBankWorker: browserTask(task, cluster, vpc, sg),
        ProcessResult: call("process", "ImportOutcome", "$.result"),
        ImportOutcome: {
          Type: "Choice",
          Choices: [
            {
              Variable: "$.result.failed",
              BooleanEquals: true,
              Next: "ReleaseFailure",
            },
          ],
          Default: "Finish",
        },
        Finish: {
          Type: "Task",
          Resource: fn.functionArn,
          Parameters: { action: "release", "job.$": "$.job" },
          End: true,
        },
        FailJob: {
          Type: "Task",
          Resource: fn.functionArn,
          Parameters: { action: "fail", "job.$": "$.job" },
          ResultPath: "$.failureResult",
          Catch: [
            {
              ErrorEquals: ["States.ALL"],
              ResultPath: "$.failure",
              Next: "ReleaseFailure",
            },
          ],
          Next: "ReleaseFailure",
        },
        ReleaseFailure: {
          Type: "Task",
          Resource: fn.functionArn,
          Parameters: { action: "release", "job.$": "$.job" },
          Next: "Failed",
        },
        Failed: { Type: "Fail", Error: "BankJobFailed" },
        Blocked: { Type: "Fail", Error: "BankAuthenticationBlocked" },
        Done: { Type: "Succeed" },
      },
    }),
  });
  return workflow;
}
