// Live, read-only bank verification. The same DynamoDB lease guards local and ECS logins.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cfg = JSON.parse(
  readFileSync(path.join(root, "cdk/deploy.local.json"), "utf8"),
);
const temp = mkdtempSync(path.join(tmpdir(), "eq-verification-"));
const region = "ca-central-1";
function aws(args) {
  const r = spawnSync("aws", [...args, "--region", region, "--no-cli-pager"], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("EQ verification AWS operation failed");
  return r.stdout;
}
function invoke(payload) {
  const out = path.join(temp, "response.json");
  const result = JSON.parse(
    aws([
      "lambda",
      "invoke",
      "--function-name",
      "transactions-eq-coordinator",
      "--cli-binary-format",
      "raw-in-base64-out",
      "--payload",
      JSON.stringify(payload),
      out,
    ]),
  );
  if (result.FunctionError)
    throw new Error("EQ coordinator rejected verification request");
  return JSON.parse(readFileSync(out, "utf8"));
}
let job;
try {
  const id = "eq-local-" + randomUUID();
  const prepared = invoke({
    action: "prepare",
    execution: id,
    job: { version: 1, source: "manual", dryRun: true },
  });
  if (!prepared.acquired)
    throw new Error(
      prepared.blocked
        ? "EQ credentials are paused"
        : "An EQ job already holds the lease",
    );
  job = prepared.job;
  const worker = spawnSync("bun", ["run", "src/index.ts"], {
    cwd: root,
    stdio: "inherit",
    timeout: 480000,
    env: {
      ...process.env,
      BANK: "eq-bank",
      DRY_RUN: "true",
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      AWS_SECRET_ARN: cfg.secretArn,
      AWS_S3_TRACES_BUCKET_NAME: cfg.tracesBucketName,
      YNAB_BUDGET_ID: cfg.ynabBudgetId,
      EQ_STATE_BUCKET: `transactions-eq-state-187489282488-${region}`,
      EQ_JOB_ID: id,
      EQ_FORCE_LOGIN: String(process.argv.includes("--fresh-login")),
    },
  });
  if (worker.status !== 0) throw new Error("EQ local browser worker failed");
  const out = path.join(temp, "result.json");
  aws([
    "s3api",
    "get-object",
    "--bucket",
    `transactions-eq-state-187489282488-${region}`,
    "--key",
    `jobs/${id}/result.json`,
    out,
  ]);
  const result = JSON.parse(readFileSync(out, "utf8"));
  if (!result.complete || result.requestId !== job.requestId)
    throw new Error(
      "EQ retrieval failed; inspect the private diagnostic record",
    );
  console.log(
    JSON.stringify(
      {
        jobId: id,
        complete: true,
        records: result.records.map((r) => ({
          account: r.accountId,
          date: r.date,
          amount: r.amount,
          description: r.description,
          status: r.status,
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (job) {
    invoke({ action: "finish", job });
  }
  rmSync(temp, { recursive: true, force: true });
}
