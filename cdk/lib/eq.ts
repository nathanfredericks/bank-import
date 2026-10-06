import * as cdk from "aws-cdk-lib";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { browserTask } from "./sessions";

export function configureEQ(
  stack: cdk.Stack,
  task: ecs.FargateTaskDefinition,
  cluster: ecs.Cluster,
  vpc: ec2.Vpc,
  sg: ec2.SecurityGroup,
  group: scheduler.CfnScheduleGroup,
  timezone: string,
  enabled: boolean,
  sessionFn: lambda.Function,
) {
  const bucketName = `transactions-eq-state-${stack.account}-${stack.region}`;
  const bucket = s3.Bucket.fromBucketName(stack, "EQStateBucket", bucketName);
  bucket.grantReadWrite(task.taskRole);
  const worker = task.defaultContainer!;
  worker.addEnvironment("EQ_STATE_BUCKET", bucketName);
  worker.addEnvironment("EQ_START_DATE", "2026-10-02");
  const coordinator = `arn:aws:lambda:${stack.region}:${stack.account}:function:transactions-eq-coordinator`;
  const role = new iam.Role(stack, "EQWorkflowRole", {
    assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
  });
  sessionFn.grantInvoke(role);
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [coordinator],
    }),
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
      actions: ["ecs:StopTask", "ecs:DescribeTasks"],
      resources: [
        `arn:aws:ecs:${stack.region}:${stack.account}:task/${cluster.clusterName}/*`,
      ],
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
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["events:PutTargets", "events:PutRule", "events:DescribeRule"],
      resources: [
        `arn:aws:events:${stack.region}:${stack.account}:rule/StepFunctionsGetEventsForECSTaskRule`,
      ],
    }),
  );
  const lambdaRetry = [
    {
      ErrorEquals: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      IntervalSeconds: 2,
      MaxAttempts: 3,
      BackoffRate: 2,
    },
  ];
  const failure = [
    { ErrorEquals: ["States.ALL"], ResultPath: "$.failure", Next: "FailJob" },
  ];
  const definition = {
    Comment: "Serialized EQ history retrieval and YNAB reconciliation",
    StartAt: "Initialize",
    TimeoutSeconds: 2700,
    States: {
      Initialize: {
        Type: "Pass",
        Parameters: { "job.$": "$", attempt: 0 },
        Next: "Prepare",
      },
      Prepare: {
        Type: "Task",
        Resource: coordinator,
        Parameters: {
          action: "prepare",
          "execution.$": "$$.Execution.Name",
          "job.$": "$.job",
        },
        ResultPath: "$.control",
        Retry: lambdaRetry,
        Next: "Lease",
      },
      Lease: {
        Type: "Choice",
        Choices: [
          { Variable: "$.control.blocked", IsPresent: true, Next: "Blocked" },
          { Variable: "$.control.done", IsPresent: true, Next: "Done" },
          {
            Variable: "$.control.acquired",
            BooleanEquals: true,
            Next: "AdoptJob",
          },
        ],
        Default: "WaitForLease",
      },
      Blocked: {
        Type: "Fail",
        Error: "EQCredentialsBlocked",
        Cause:
          "Review credentials and remove the circuit breaker before fresh login",
      },
      Done: { Type: "Succeed" },
      WaitForLease: { Type: "Wait", Seconds: 15, Next: "Prepare" },
      AdoptJob: {
        Type: "Pass",
        Parameters: {
          "job.$": "$.control.job",
          "attempt.$": "$.attempt",
          result: { maintenance: false },
        },
        Next: "TryAPI",
      },
      TryAPI: {
        Type: "Task",
        Resource: sessionFn.functionArn,
        Parameters: { action: "fetch", "job.$": "$.job" },
        ResultPath: "$.api",
        Catch: failure,
        Next: "APIAvailable",
      },
      APIAvailable: {
        Type: "Choice",
        Choices: [
          {
            Variable: "$.api.outcome",
            StringEquals: "authentication-required",
            Next: "RunBankWorker",
          },
        ],
        Default: "AdoptAPIResult",
      },
      AdoptAPIResult: {
        Type: "Pass",
        Parameters: {
          "transport.$": "$.api.transport",
          "jobId.$": "$.api.jobId",
          "requestId.$": "$.api.requestId",
        },
        ResultPath: "$.worker",
        Next: "ProcessResult",
      },
      RunBankWorker: browserTask(task, cluster, vpc, sg, true),
      ProcessResult: {
        Type: "Choice",
        Choices: [
          {
            Variable: "$.job.purpose",
            StringEquals: "maintain-session",
            Next: "ProcessSession",
          },
        ],
        Default: "Reconcile",
      },
      ProcessSession: {
        Type: "Task",
        Resource: sessionFn.functionArn,
        Parameters: { action: "process", "job.$": "$.job" },
        ResultPath: "$.sessionResult",
        Catch: failure,
        Next: "SessionOutcome",
      },
      SessionOutcome: {
        Type: "Choice",
        Choices: [
          {
            Variable: "$.sessionResult.failed",
            BooleanEquals: true,
            Next: "SessionFailureRelease",
          },
        ],
        Default: "Finish",
      },
      SessionFailureRelease: {
        Type: "Task",
        Resource: coordinator,
        Parameters: { action: "finish", "job.$": "$.job" },
        Next: "Failed",
      },
      Reconcile: {
        Type: "Task",
        Resource: coordinator,
        Parameters: {
          action: "process",
          "job.$": "$.job",
          "worker.$": "$.worker",
        },
        ResultPath: "$.result",
        Retry: lambdaRetry,
        Catch: failure,
        Next: "ActivityAvailable",
      },
      ActivityAvailable: {
        Type: "Choice",
        Choices: [
          {
            Variable: "$.result.missing",
            BooleanEquals: false,
            Next: "Finish",
          },
          {
            Variable: "$.attempt",
            NumericLessThan: 3,
            Next: "ReleaseForRetry",
          },
        ],
        Default: "FailJob",
      },
      ReleaseForRetry: {
        Type: "Task",
        Resource: coordinator,
        Parameters: { action: "finish", "job.$": "$.job" },
        ResultPath: "$.released",
        Retry: lambdaRetry,
        Next: "RetryDelay",
      },
      RetryDelay: {
        Type: "Choice",
        Choices: [
          { Variable: "$.attempt", NumericEquals: 0, Next: "WaitOneMinute" },
          { Variable: "$.attempt", NumericEquals: 1, Next: "WaitFiveMinutes" },
        ],
        Default: "WaitFifteenMinutes",
      },
      WaitOneMinute: { Type: "Wait", Seconds: 60, Next: "Increment" },
      WaitFiveMinutes: { Type: "Wait", Seconds: 300, Next: "Increment" },
      WaitFifteenMinutes: { Type: "Wait", Seconds: 900, Next: "Increment" },
      Increment: {
        Type: "Pass",
        Parameters: {
          "job.$": "$.job",
          "attempt.$": "States.MathAdd($.attempt, 1)",
        },
        Next: "Prepare",
      },
      Finish: {
        Type: "Task",
        Resource: coordinator,
        Parameters: { action: "finish", "job.$": "$.job" },
        ResultPath: "$.finish",
        Retry: lambdaRetry,
        End: true,
      },
      FailJob: {
        Type: "Choice",
        Choices: [
          {
            Variable: "$.job.purpose",
            StringEquals: "maintain-session",
            Next: "FailSession",
          },
        ],
        Default: "FailImport",
      },
      FailSession: {
        Type: "Task",
        Resource: sessionFn.functionArn,
        Parameters: { action: "fail", "job.$": "$.job" },
        ResultPath: "$.sessionFailure",
        Catch: [
          {
            ErrorEquals: ["States.ALL"],
            ResultPath: "$.sessionFailure",
            Next: "SessionFailureRelease",
          },
        ],
        Next: "SessionFailureRelease",
      },
      FailImport: {
        Type: "Task",
        Resource: coordinator,
        Parameters: {
          action: "fail",
          "job.$": "$.job",
          "maintenance.$": "$.result.maintenance",
        },
        ResultPath: "$.finish",
        Retry: lambdaRetry,
        Next: "Failed",
      },
      Failed: {
        Type: "Fail",
        Error: "EQImportFailed",
        Cause:
          "Worker, reconciliation or bounded alert lookup failed; private results retained",
      },
    },
  };
  const workflow = new sfn.CfnStateMachine(stack, "EQWorkflow", {
    stateMachineName: "bank-import-eq",
    roleArn: role.roleArn,
    definitionString: stack.toJsonString(definition),
  });
  const scheduleRole = new iam.Role(stack, "EQScheduleRole", {
    assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
  });
  scheduleRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["states:StartExecution"],
      resources: [workflow.attrArn],
    }),
  );
  const schedule = new scheduler.CfnSchedule(
    stack,
    "BankImportSchedule-EQBank",
    {
      groupName: group.ref,
      name: "bank-import-eq-bank",
      state: enabled ? "ENABLED" : "DISABLED",
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "cron(0 0/4 * * ? *)",
      scheduleExpressionTimezone: timezone,
      target: {
        arn: workflow.attrArn,
        roleArn: scheduleRole.roleArn,
        input: JSON.stringify({
          version: 1,
          source: "scheduled",
          dryRun: false,
        }),
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
      },
    },
  );
  new cdk.CfnOutput(stack, "EQWorkflowArn", { value: workflow.attrArn });
  new cdk.CfnOutput(stack, "EQBankScheduleName", { value: schedule.ref });
  return workflow;
}
