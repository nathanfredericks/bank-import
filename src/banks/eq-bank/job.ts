import env from "../../utils/env";
import secrets from "../../utils/secrets";
import { EQBank, EQCredentialsRejected, EQMaintenance } from "./EQBank";
import { readState, writeState } from "./store";
import { EQJob } from "./types";

export async function runEQJob() {
  const job = EQJob.parse(await readState(`jobs/${env.EQ_JOB_ID}/job.json`));
  if (job.jobId !== env.EQ_JOB_ID || job.dryRun !== env.DRY_RUN)
    throw new Error("EQ job envelope does not match worker configuration");
  if (!secrets.EQ_BANK_USERNAME || !secrets.EQ_BANK_PASSWORD)
    throw new Error("EQ credentials are missing from Secrets Manager");
  try {
    const records = await new EQBank().retrieve(
      secrets.EQ_BANK_USERNAME,
      secrets.EQ_BANK_PASSWORD,
    );
    await writeState(`jobs/${job.jobId}/result.json`, {
      version: 1,
      jobId: job.jobId,
      requestId: job.requestId,
      complete: true,
      records,
    });
  } catch (error) {
    // The coordinator owns failure notification and the credential circuit breaker.
    await writeState(`jobs/${job.jobId}/result.json`, {
      version: 1,
      jobId: job.jobId,
      requestId: job.requestId,
      complete: false,
      error:
        error instanceof EQMaintenance
          ? "bank-maintenance"
          : error instanceof EQCredentialsRejected
          ? "credentials-rejected"
          : "bank-retrieval-failed",
    });
  }
}
