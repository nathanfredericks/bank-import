import {
  SFNClient,
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
} from "@aws-sdk/client-sfn";
import { BankName } from "../banks/types";
import { SessionStore } from "./store";
import { SessionJob, failureKind } from "./types";

export async function runSessionWorker() {
  const store = new SessionStore();
  const job = SessionJob.parse(
    await store.object(
      store.jobKey({ jobId: process.env.BANK_JOB_ID! }, "job.json"),
    ),
  );
  if (
    job.jobId !== process.env.BANK_JOB_ID ||
    (process.env.BANK_REQUEST_ID &&
      job.requestId !== process.env.BANK_REQUEST_ID) ||
    job.dryRun !== (process.env.DRY_RUN === "true")
  )
    throw new Error("Bank worker envelope mismatch");
  const client = new SFNClient({});
  try {
    await store.assertLease(job.jobId);
    let result: Record<string, unknown>;
    try {
      const { default: secrets } = await import("../utils/secrets");
      if (store.bank === BankName.EQBank) {
        const { EQBank } = await import("../banks/eq-bank/EQBank");
        const records = await new EQBank().retrieve(
          secrets.EQ_BANK_USERNAME!,
          secrets.EQ_BANK_PASSWORD!,
        );
        result = { complete: true, records };
      } else {
        const bank =
          store.bank === BankName.RogersBank
            ? await (
                await import("../banks/rogers-bank/RogersBank")
              ).RogersBank.create(
                secrets.ROGERS_BANK_USERNAME,
                secrets.ROGERS_BANK_PASSWORD,
              )
            : await (
                await import("../banks/nbdb/NBDB")
              ).NBDB.create(secrets.NBDB_USER_ID, secrets.NBDB_PASSWORD);
        result = { complete: true, accounts: bank.getAccounts() };
      }
    } catch (error) {
      result = { complete: false, error: failureKind(error) };
    }
    await store.saveResult(job, { ...result, transport: "browser-callback" });
    if (result.complete)
      await store.put(
        "session-health",
        { failures: 0, retryAfter: 0, notified: false },
        job.jobId,
      );
    if (process.env.BANK_TASK_TOKEN)
      await client.send(
        new SendTaskSuccessCommand({
          taskToken: process.env.BANK_TASK_TOKEN,
          output: JSON.stringify({
            transport: "browser-callback",
            jobId: job.jobId,
            requestId: job.requestId,
          }),
        }),
      );
    console.info(
      JSON.stringify({
        event: "browser-result-published",
        bank: store.bank,
        jobId: job.jobId,
        complete: result.complete,
      }),
    );
  } catch {
    if (process.env.BANK_TASK_TOKEN)
      await client
        .send(
          new SendTaskFailureCommand({
            taskToken: process.env.BANK_TASK_TOKEN,
            error: "BankWorkerFailed",
            cause: "Private bank worker publication failed",
          }),
        )
        .catch(() => {});
    throw new Error("Bank worker failed");
  }
}
