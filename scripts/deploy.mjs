import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

class OperationalError extends Error {}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const region = "ca-central-1";
const account = "187489282488";
const banks = z.enum(["rogers-bank", "nbdb", "eq-bank"]);
const Config = z
  .object({
    tracesBucketName: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    timezone: z.literal("America/Halifax"),
    secretArn: z
      .string()
      .regex(
        /^arn:aws:secretsmanager:ca-central-1:187489282488:secret:bank-import-[A-Za-z0-9]+$/,
      ),
    ynabBudgetId: z.uuid(),
    ynabAdjustmentPayeeId: z.uuid(),
    nbdbExcludedAccountIds: z.array(z.uuid()).default([]),
    rogersEmailSender: z.email(),
    rogersEmailSubject: z.string().min(1),
    rogersEmailCodeLength: z.number().int().min(4).max(12),
    enabledBanks: z.array(banks).default([]),
    verifiedBanks: z.array(banks).default([]),
  })
  .strict();
const [command, ...args] = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath =
  configIndex >= 0 ? args[configIndex + 1] : "cdk/deploy.local.json";

function exec(
  executable,
  argv,
  { input, inherit = false, cwd = root, env = {} } = {},
) {
  const result = spawnSync(executable, argv, {
    cwd,
    input,
    encoding: "utf8",
    stdio: inherit
      ? input === undefined
        ? "inherit"
        : ["pipe", "inherit", "inherit"]
      : "pipe",
    env: {
      ...process.env,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      AWS_PAGER: "",
      CDK_DISABLE_CLI_TELEMETRY: "1",
      ...env,
    },
  });
  if (result.error || result.status !== 0)
    throw new OperationalError(
      `${executable} command failed; check credentials, permissions, and configuration`,
    );
  return inherit ? undefined : result.stdout;
}
function aws(...argv) {
  return JSON.parse(
    exec("aws", [
      ...argv,
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ]),
  );
}
function identity() {
  const who = aws("sts", "get-caller-identity");
  if (who.Account !== account) throw new OperationalError("Wrong AWS account");
  if (who.Arn.endsWith(":root")) {
    // Explicit operator override for host-side deployment only. Never export root
    // credentials into a local worker or any deployed container.
    if (args.includes("--allow-root")) {
      console.log(
        "Using explicitly authorized local root credentials for AWS control-plane operations only.",
      );
      return;
    }
    throw new OperationalError(
      "Root credentials require the explicit --allow-root host-side override.",
    );
  }
  if (!who.Arn.startsWith("arn:aws:sts:"))
    throw new OperationalError(
      "Use temporary assumed-role or federated credentials.",
    );
  console.log("Verified non-root AWS session in the intended account.");
}
function configuration() {
  const result = Config.safeParse(
    JSON.parse(readFileSync(path.resolve(root, configPath), "utf8")),
  );
  if (!result.success)
    throw new OperationalError(
      `Missing or invalid configuration fields: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const config = result.data;
  if (
    new Set(config.enabledBanks).size !== config.enabledBanks.length ||
    new Set(config.verifiedBanks).size !== config.verifiedBanks.length
  )
    throw new OperationalError("Duplicate bank selection");
  if (config.enabledBanks.some((bank) => !config.verifiedBanks.includes(bank)))
    throw new OperationalError(
      "Enabled banks must have completed email, dry-run, and live-import verification",
    );
  return config;
}
function cdk(command, config) {
  exec(
    "npm",
    [
      "run",
      "cdk",
      "--",
      command,
      "--no-lookups",
      "-c",
      `enabledBanks=${config.enabledBanks.join(",")}`,
      "-c",
      `verifiedBanks=${config.verifiedBanks.join(",")}`,
      ...(command === "deploy"
        ? ["--outputs-file", "outputs.json", "--require-approval", "broadening"]
        : []),
    ],
    { inherit: true, cwd: path.join(root, "cdk") },
  );
}
function parameterValues(config) {
  return {
    "traces-bucket-name": config.tracesBucketName,
    timezone: config.timezone,
    "secret-arn": config.secretArn,
    "ynab-budget-id": config.ynabBudgetId,
    "ynab-adjustment-payee-id": config.ynabAdjustmentPayeeId,
    "nbdb-excluded-account-ids": JSON.stringify(config.nbdbExcludedAccountIds),
    "rogers-email-sender": config.rogersEmailSender,
    "rogers-email-subject": config.rogersEmailSubject,
    "rogers-email-code-length": String(config.rogersEmailCodeLength),
  };
}
async function preflight(config) {
  const response = aws(
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    config.secretArn,
  );
  const secrets = JSON.parse(response.SecretString);
  const required = [
    "ROGERS_BANK_USERNAME",
    "ROGERS_BANK_PASSWORD",
    "NBDB_USER_ID",
    "NBDB_PASSWORD",
    "PUSHOVER_TOKEN",
    "PUSHOVER_USER",
    "YNAB_ACCESS_TOKEN",
    "JMAP_BEARER_TOKEN",
  ];
  const missing = required.filter(
    (key) => typeof secrets[key] !== "string" || !secrets[key].length,
  );
  if (missing.length)
    throw new OperationalError(
      `Secret is missing fields: ${missing.join(", ")}`,
    );
  async function json(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new OperationalError(
        `Preflight request to ${new URL(url).hostname} failed (HTTP ${response.status})`,
      );
    return response.json();
  }
  const mailHeaders = {
    Authorization: `Bearer ${secrets.JMAP_BEARER_TOKEN}`,
    "Content-Type": "application/json",
  };
  const session = await json("https://api.fastmail.com/jmap/session", {
    headers: mailHeaders,
  });
  const mailUrl = new URL(session.apiUrl);
  if (
    mailUrl.protocol !== "https:" ||
    mailUrl.username ||
    mailUrl.password ||
    mailUrl.port ||
    !(
      mailUrl.hostname === "api.fastmail.com" ||
      /^[a-z0-9-]+\.api\.fastmail\.com$/.test(mailUrl.hostname)
    )
  )
    throw new OperationalError("Unexpected JMAP origin");
  const mailAccount = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  if (!mailAccount)
    throw new OperationalError("No primary Fastmail mail account");
  const mail = await json(session.apiUrl, {
    method: "POST",
    headers: mailHeaders,
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/query",
          {
            accountId: mailAccount,
            filter: {
              from: config.rogersEmailSender,
              subject: config.rogersEmailSubject,
            },
            limit: 1,
          },
          "check",
        ],
      ],
    }),
  });
  if (mail.methodResponses?.[0]?.[0] !== "Email/query")
    throw new OperationalError("Fastmail token cannot query email");
  console.log(
    "Fastmail access OK; matching Rogers message present:",
    Boolean(mail.methodResponses[0][1].ids?.length),
  );
  const ynabHeaders = { Authorization: `Bearer ${secrets.YNAB_ACCESS_TOKEN}` };
  const budgetBase = `https://api.ynab.com/v1/budgets/${config.ynabBudgetId}`;
  const accounts = await json(`${budgetBase}/accounts`, {
    headers: ynabHeaders,
  });
  const payees = await json(`${budgetBase}/payees`, { headers: ynabHeaders });
  if (
    !payees.data.payees.some(
      (p) =>
        p.id === config.ynabAdjustmentPayeeId &&
        !p.deleted &&
        !p.transfer_account_id,
    )
  )
    throw new OperationalError("NBDB payee is not valid for this YNAB budget");
  console.log(
    "YNAB budget and payee accessible; active accounts:",
    accounts.data.accounts.filter((a) => !a.deleted && !a.closed).length,
  );
  const push = await json("https://api.pushover.net/1/users/validate.json", {
    method: "POST",
    body: new URLSearchParams({
      token: secrets.PUSHOVER_TOKEN,
      user: secrets.PUSHOVER_USER,
    }),
  });
  if (push.status !== 1)
    throw new OperationalError("Pushover credentials are not valid");
  console.log(
    "Pushover credentials validated (no notification sent). Bank passwords still require a dry run.",
  );
}

try {
  if (command === "synth") {
    // Offline synthesis does not require account access or a local configuration.
    exec("npm", ["run", "cdk", "--", "synth", "--no-lookups", "--quiet"], {
      inherit: true,
      cwd: path.join(root, "cdk"),
    });
  } else if (
    ["check", "configure", "deploy", "run", "local"].includes(command)
  ) {
    identity();
    const config = configuration();
    if (command === "check") await preflight(config);
    if (command === "local") {
      const bank = banks.parse(args[0]);
      if (args.includes("--live"))
        throw new OperationalError(
          "Local validation is dry-run only; use the reviewed ECS workflow for live imports",
        );
      await preflight(config);
      const stacks = aws("cloudformation", "list-stacks").StackSummaries;
      if (
        stacks.some(
          (s) =>
            s.StackName === "BankImportStack" &&
            s.StackStatus !== "DELETE_COMPLETE",
        )
      )
        throw new OperationalError(
          "A cloud stack exists; use its guarded ECS dry-run command instead of a local login",
        );
      if (
        exec("docker", [
          "ps",
          "--filter",
          "label=bank-import-run=true",
          "--format",
          "{{.ID}}",
        ]).trim()
      )
        throw new OperationalError("Another local bank worker is active");
      exec(
        "docker",
        ["build", "--platform", "linux/arm64", "-t", "bank-import:local", "."],
        { inherit: true },
      );
      const env = {
        LOCAL_SECRETS_STDIN: "true",
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
        AWS_SECRET_ARN: config.secretArn,
        AWS_S3_TRACES_BUCKET_NAME: config.tracesBucketName,
        BANK: bank,
        DRY_RUN: "true",
        TZ: config.timezone,
        YNAB_BUDGET_ID: config.ynabBudgetId,
        YNAB_ADJUSTMENT_PAYEE_ID: config.ynabAdjustmentPayeeId,
        NBDB_EXCLUDED_ACCOUNT_IDS: JSON.stringify(
          config.nbdbExcludedAccountIds,
        ),
        ROGERS_EMAIL_SENDER: config.rogersEmailSender,
        ROGERS_EMAIL_SUBJECT: config.rogersEmailSubject,
        ROGERS_EMAIL_CODE_LENGTH: String(config.rogersEmailCodeLength),
      };
      // Fetch on the host and pipe only application secrets, never AWS credentials.
      const localSecrets = aws(
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        config.secretArn,
      ).SecretString;
      exec(
        "docker",
        [
          "run",
          "--rm",
          "--interactive",
          "--cpus",
          "1",
          "--memory",
          "2g",
          "--stop-timeout",
          "119",
          "--label",
          "bank-import-run=true",
          "--platform",
          "linux/arm64",
          ...Object.keys(env).flatMap((key) => ["--env", key]),
          "bank-import:local",
        ],
        { inherit: true, env, input: localSecrets },
      );
    }
    if (command === "configure") {
      await preflight(config);
      const values = parameterValues(config);
      for (const [name, value] of Object.entries(values)) {
        exec("aws", [
          "ssm",
          "put-parameter",
          "--cli-input-json",
          JSON.stringify({
            Name: `/bank-import/${name}`,
            Value: value,
            Type: "String",
            Overwrite: true,
          }),
          "--region",
          region,
          "--no-cli-pager",
        ]);
        console.log("Configured", name);
      }
    }
    if (command === "deploy") {
      await preflight(config);
      const expected = parameterValues(config);
      const saved = aws(
        "ssm",
        "get-parameters",
        "--names",
        ...Object.keys(expected).map((name) => `/bank-import/${name}`),
      );
      const actual = Object.fromEntries(
        saved.Parameters.map((p) => [
          p.Name.replace("/bank-import/", ""),
          p.Value,
        ]),
      );
      if (
        Object.entries(expected).some(([name, value]) => actual[name] !== value)
      )
        throw new OperationalError(
          "AWS parameters differ from local configuration; run configure before deployment",
        );
      cdk("diff", config);
      cdk("deploy", config);
    }
    if (command === "run") {
      const bank = banks.parse(args[0]);
      const live = args.includes("--live");
      if (live && !args.includes("--approve-imports"))
        throw new OperationalError(
          "Review the dry-run output first, then pass --live --approve-imports",
        );
      const stack = aws(
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        "BankImportStack",
      ).Stacks[0];
      const out = Object.fromEntries(
        stack.Outputs.map((o) => [o.OutputKey, o.OutputValue]),
      );
      {
        const result = aws(
          "stepfunctions",
          "start-execution",
          "--state-machine-arn",
          out[
            bank === "eq-bank"
              ? "EQWorkflowArn"
              : bank === "nbdb"
                ? "NBDBWorkflowArn"
                : "RogersBankWorkflowArn"
          ],
          "--input",
          JSON.stringify({
            version: 1,
            source: "manual",
            purpose: "retrieve",
            dryRun: !live,
          }),
        );
        console.log(JSON.stringify({ dryRun: !live, ...result }, null, 2));
        process.exit(0);
      }
    }
  } else {
    console.log(
      "Usage: node scripts/deploy.mjs synth|check|configure|deploy|local|run [rogers-bank|nbdb] [--config path] [--allow-root] [--live --approve-imports]",
    );
    process.exitCode = 1;
  }
} catch (error) {
  // Only our own operational messages are printed; SDK/API bodies and secret values are not.
  const message =
    error instanceof OperationalError
      ? error.message
      : "Invalid local configuration or service response";
  console.error(message);
  process.exitCode = 1;
}
