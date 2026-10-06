import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Account, BankName } from "../banks/types";
import { SessionStore } from "./store";
import { BankTransport } from "./client";
import { BankFailure, failureKind, SessionJob, type Job } from "./types";

const ssm = new SSMClient({});
async function policy() {
  const result = await ssm.send(
    new GetParameterCommand({
      Name: `/bank-import/sessions/${process.env.BANK}`,
    }),
  );
  return z
    .object({
      direct: z.boolean(),
      renew: z.boolean(),
      maintenance: z.boolean(),
    })
    .parse(JSON.parse(result.Parameter!.Value!));
}
async function importAccounts(
  accounts: z.infer<typeof Account>[],
  dryRun: boolean,
) {
  const [{ default: secrets }, { default: env }, { createYnabImporter }, ynab] =
    await Promise.all([
      import("../utils/secrets"),
      import("../utils/env"),
      import("../ynab"),
      import("ynab"),
    ]);
  const importer = createYnabImporter(new ynab.API(secrets.YNAB_ACCESS_TOKEN), {
    budgetId: env.YNAB_BUDGET_ID,
    adjustmentPayeeId: env.YNAB_ADJUSTMENT_PAYEE_ID,
    dryRun,
    log: (message) => console.info(message),
  });
  if (env.BANK === BankName.RogersBank)
    await importer.importTransactions(accounts);
  else
    await importer.updateAccountBalances(
      accounts.filter((a) => !env.NBDB_EXCLUDED_ACCOUNT_IDS.includes(a.id)),
    );
}
export async function handler(event: {
  action: string;
  execution?: string;
  job?: unknown;
  renew?: boolean;
  baselineJobId?: string;
}) {
  const started = Date.now();
  const store = new SessionStore();
  try {
    if (event.action === "maintain") {
      const enabled = await policy();
      if (
        !enabled.maintenance ||
        !enabled.direct ||
        (await store.read("credentials-blocked"))
      )
        return { outcome: "disabled" };
      const health = await store.read<{ retryAfter: number }>("session-health");
      if (health && health.retryAfter > Date.now())
        return { outcome: "deferred" };
      const session = await store.session();
      if (
        session &&
        (session.refreshAfter ?? Date.parse(session.savedAt) + 300_000) >
          Date.now()
      )
        return { outcome: "not-due" };
      const name = `session-${store.bank}-${Math.floor(Date.now() / 60000)}`;
      await new SFNClient({}).send(
        new StartExecutionCommand({
          stateMachineArn: process.env.SESSION_WORKFLOW_ARN,
          name,
          input: JSON.stringify({
            version: 1,
            source: "session",
            purpose: "maintain-session",
            dryRun: false,
          }),
        }),
      );
      return { outcome: "started" };
    }
    if (event.action === "probe")
      return await probe(store, event.renew === true, event.baselineJobId);
    if (event.action === "prepare") {
      const job = SessionJob.parse({
        ...(event.job as object),
        jobId: event.execution,
        requestId: randomUUID(),
        receivedAt: (event.job as any)?.receivedAt ?? new Date().toISOString(),
      });
      if (job.source === "session" && job.purpose !== "maintain-session")
        throw new Error("Invalid maintenance purpose");
      if (job.purpose === "maintain-session" && !(await policy()).maintenance)
        return { done: true, blocked: false, acquired: false, job };
      if (await store.read("credentials-blocked"))
        return { blocked: true, done: false, acquired: false, job };
      if (await store.read(`done#${job.jobId}`))
        return { done: true, blocked: false, acquired: false, job };
      const acquired = await store.acquire(job.jobId);
      if (acquired) {
        try {
          await store.upload(store.jobKey(job, "job.json"), job);
        } catch (error) {
          await store.release(job.jobId);
          throw error;
        }
      }
      return { acquired, done: false, blocked: false, job };
    }
    const job = SessionJob.parse(event.job);
    if (event.action === "release") {
      await store.release(job.jobId);
      return { released: true };
    }
    await store.assertLease(job.jobId);
    const current = await store.object<Job>(store.jobKey(job, "job.json"));
    if (current?.requestId !== job.requestId) throw new Error("Stale bank job");
    if (event.action === "fetch") return await fetchSession(store, job);
    if (event.action === "process") {
      const result = await store.object<any>(store.jobKey(job, "result.json"));
      if (
        !result ||
        result.jobId !== job.jobId ||
        result.requestId !== job.requestId ||
        result.version !== 1
      )
        throw new Error("Invalid bank result envelope");
      if (!result.complete) {
        await recordFailure(store, job, result.error);
        return { failed: true, reason: result.error };
      }
      if (job.purpose !== "maintain-session") {
        // No workflow retries around non-idempotent NBDB writes. A persisted
        // attempt marker also rejects redelivery after an uncertain invocation.
        const marker = `import#${job.jobId}`;
        const previous = await store.read<{ status: string }>(marker);
        if (previous?.status === "started")
          throw new Error("Bank import outcome uncertain; review required");
        if (previous?.status !== "complete") {
          if (!job.dryRun)
            await store.put(
              marker,
              { status: "started", requestId: job.requestId },
              job.jobId,
            );
          await importAccounts(
            z.array(Account).parse(result.accounts),
            job.dryRun,
          );
          if (!job.dryRun)
            await store.put(marker, { status: "complete" }, job.jobId);
        }
      }
      if (!["deferred", "disabled", "not-due"].includes(result.outcome))
        await store.put(
          "session-health",
          { failures: 0, retryAfter: 0, notified: false },
          job.jobId,
        );
      await store.put(
        `done#${job.jobId}`,
        { at: new Date().toISOString(), purpose: job.purpose },
        job.jobId,
      );
      return { failed: false, purpose: job.purpose };
    }
    if (event.action === "fail") {
      await recordFailure(store, job, "transport-failed");
      return { failed: true };
    }
    throw new Error("Unknown bank workflow action");
  } catch (error) {
    // SDK and HTTP errors may contain signed requests. Never serialize them.
    console.error(
      JSON.stringify({
        event: "bank-workflow-error",
        bank: store.bank,
        action: event.action,
        kind: failureKind(error),
      }),
    );
    throw new Error(
      "Bank workflow operation failed; inspect private job status",
    );
  } finally {
    console.info(
      JSON.stringify({
        event: "bank-stage",
        bank: store.bank,
        action: event.action,
        durationMs: Date.now() - started,
      }),
    );
  }
}
async function fetchSession(store: SessionStore, job: Job) {
  await store.put(
    "active-request",
    { jobId: job.jobId, requestId: job.requestId },
    job.jobId,
  );
  const enabled = await policy();
  if (job.purpose === "maintain-session" && !enabled.maintenance) {
    await store.saveResult(job, {
      complete: true,
      records: [],
      accounts: [],
      outcome: "disabled",
    });
    return {
      outcome: "ready",
      jobId: job.jobId,
      requestId: job.requestId,
      transport: "api",
    };
  }
  const health = await store.read<{ retryAfter: number }>("session-health");
  if (
    job.purpose === "maintain-session" &&
    health &&
    health.retryAfter > Date.now()
  ) {
    await store.saveResult(job, {
      complete: true,
      records: [],
      accounts: [],
      outcome: "deferred",
    });
    return {
      outcome: "ready",
      jobId: job.jobId,
      requestId: job.requestId,
      transport: "api",
    };
  }
  const session = await store.session();
  if (!session || !enabled.direct)
    return { outcome: "authentication-required", forceLogin: true };
  if (
    job.purpose === "maintain-session" &&
    (session.refreshAfter ?? Date.parse(session.savedAt) + 300_000) > Date.now()
  ) {
    await store.saveResult(job, {
      complete: true,
      records: [],
      accounts: [],
      outcome: "not-due",
    });
    return {
      outcome: "ready",
      jobId: job.jobId,
      requestId: job.requestId,
      transport: "api",
    };
  }
  const transport = await BankTransport.open(session);
  try {
    let renewalTried = false;
    if (session.maximumExpiresAt && session.maximumExpiresAt <= Date.now())
      throw new BankFailure("authentication-required");
    if ((session.refreshAfter ?? Infinity) <= Date.now() && enabled.renew) {
      renewalTried = true;
      await transport.renew();
      // Save rotated credentials before any subsequent request can fail.
      await transport.persist(job.jobId);
    } else if (session.expiresAt && session.expiresAt <= Date.now())
      throw new BankFailure("authentication-required");
    let data;
    try {
      data = await transport.fetchData(job.purpose === "maintain-session");
    } catch (error) {
      if (
        !enabled.renew ||
        renewalTried ||
        failureKind(error) !== "authentication-required"
      )
        throw error;
      await transport.renew();
      await transport.persist(job.jobId);
      data = await transport.fetchData(job.purpose === "maintain-session");
    }
    await transport.persist(job.jobId);
    await store.put(
      "session-health",
      { failures: 0, retryAfter: 0, notified: false },
      job.jobId,
    );
    await store.saveResult(job, { complete: true, ...data, transport: "api" });
    return {
      outcome: "ready",
      transport: "api",
      jobId: job.jobId,
      requestId: job.requestId,
    };
  } catch (error) {
    const kind = failureKind(error);
    if (kind === "authentication-required")
      return { outcome: kind, forceLogin: true };
    await store.saveResult(job, { complete: false, error: kind });
    return {
      outcome: "failed",
      transport: "api",
      jobId: job.jobId,
      requestId: job.requestId,
    };
  } finally {
    try {
      await transport.persistRotation(job.jobId);
    } finally {
      await transport.close();
    }
  }
}
export async function recordFailure(
  store: SessionStore,
  job: Job,
  kind: string,
) {
  const previous = await store.read<{ failures: number; notified: boolean }>(
    "session-health",
  );
  const failures = (previous?.failures ?? 0) + 1;
  if (["credentials-rejected", "challenge-required"].includes(kind))
    await store.put(
      "credentials-blocked",
      { at: new Date().toISOString(), reason: kind },
      job.jobId,
    );
  const retryAfter =
    Date.now() + Math.min(4 * 3600_000, 60_000 * 2 ** Math.min(failures, 8));
  await store.put(
    "session-health",
    { failures, retryAfter, notified: previous?.notified ?? false, kind },
    job.jobId,
  );
  if (!job.dryRun && !previous?.notified) {
    const { sendNotification } = await import("../utils/pushover");
    await sendNotification(
      `${store.bank}: ${kind}. Automatic session recovery is paused or backing off.`,
      { title: "Bank session requires attention" },
    );
    await store.put(
      "session-health",
      { failures, retryAfter, notified: true, kind },
      job.jobId,
    );
  }
}
async function probe(
  store: SessionStore,
  renew: boolean,
  baselineJobId?: string,
) {
  const owner = `probe-${randomUUID()}`;
  if (!(await store.acquire(owner))) return { outcome: "busy" };
  let transport: BankTransport | undefined;
  try {
    const session = await store.session();
    if (!session) return { outcome: "no-session" };
    transport = await BankTransport.open(session);
    const previousToken = session.headers.authorization;
    if (renew) {
      await transport.renew();
      await transport.persist(owner);
    }
    const data = await transport.fetchData();
    await transport.persist(owner);
    let matches: boolean | undefined;
    if (baselineJobId) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(baselineJobId))
        throw new Error("Invalid baseline job");
      const baseline = await store.object<any>(
        store.jobKey({ jobId: baselineJobId }, "result.json"),
      );
      const canonical = (value: unknown) =>
        JSON.stringify(value, (_key, v) =>
          v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(
                Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
              )
            : v,
        );
      matches =
        !!baseline?.complete &&
        canonical(data) ===
          canonical(
            "records" in data
              ? { records: baseline.records }
              : { accounts: baseline.accounts },
          );
    }
    const proof = {
      version: 1,
      at: new Date().toISOString(),
      bank: store.bank,
      renewed: renew,
      rotated: renew && previousToken !== session.headers.authorization,
      count: data.records?.length ?? data.accounts?.length ?? 0,
      matches,
    };
    await store.upload(`verification/${store.bank}/${owner}.json`, proof);
    return { outcome: "ready", ...proof };
  } catch (error) {
    return { outcome: "failed", kind: failureKind(error) };
  } finally {
    try {
      if (transport) await transport.persistRotation(owner);
    } finally {
      try {
        if (transport) await transport.close();
      } finally {
        await store.release(owner);
      }
    }
  }
}
