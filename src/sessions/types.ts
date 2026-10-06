import type { BrowserContext } from "playwright-core";
import { z } from "zod";
import { BankName } from "../banks/types";

export const SessionJob = z.object({
  version: z.literal(1),
  jobId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  requestId: z.string().min(1),
  source: z.enum(["alert", "scheduled", "manual", "session"]),
  purpose: z.enum(["retrieve", "maintain-session"]).default("retrieve"),
  dryRun: z.boolean(),
  messageId: z.string().optional(),
  alertAmount: z.number().int().positive().optional(),
  alertDate: z.string().date().optional(),
  receivedAt: z.string().optional(),
});
export type Job = z.infer<typeof SessionJob>;
export type BrowserState = {
  state: Awaited<ReturnType<BrowserContext["storageState"]>>;
  sessions: Record<string, Record<string, string>>;
};
export type BankSession = BrowserState & {
  version: 1;
  bank: BankName;
  savedAt: string;
  expiresAt?: number;
  refreshAfter?: number;
  maximumExpiresAt?: number;
  headers: Record<string, string>;
  accountId?: string;
  customerId?: string;
  endpoint?: string;
  authenticationObserved?: {
    path: string;
    method: string;
    status: number;
    fields: string[];
  }[];
  refresh?: {
    url: string;
    body: Record<string, string>;
    headers: Record<string, string>;
  };
  authorization?: {
    tokenUrl: string;
    clientId: string;
    redirectUri: string;
    scope: string;
    headers: Record<string, string>;
  };
};
export type FailureKind =
  | "authentication-required"
  | "credentials-rejected"
  | "challenge-required"
  | "bank-maintenance"
  | "throttled"
  | "transport-failed"
  | "invalid-response";
export class BankFailure extends Error {
  constructor(public kind: FailureKind) {
    super(kind);
  }
}
export function failureKind(error: unknown): FailureKind {
  if (error instanceof BankFailure) return error.kind;
  if (error instanceof Error) {
    if (error.name === "EQMaintenance") return "bank-maintenance";
    if (/credentials.*rejected|rejected credentials/i.test(error.message))
      return "credentials-rejected";
    if (/verification.*not reached|Expected one email/i.test(error.message))
      return "challenge-required";
  }
  return "transport-failed";
}

export function authenticationHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        !key.startsWith(":") &&
        ![
          "host",
          "cookie",
          "content-length",
          "connection",
          "accept-encoding",
        ].includes(key.toLowerCase()),
    ),
  );
}
export function tokenTiming(session: BankSession) {
  const token =
    session.headers.authorization?.replace(/^Bearer\s+/i, "") ??
    session.headers.accesstoken;
  try {
    const claims = JSON.parse(
      Buffer.from(token!.split(".")[1]!, "base64url").toString(),
    );
    if (typeof claims.exp === "number") session.expiresAt = claims.exp * 1000;
    const maximum = claims["https://eqbank.ca/session/max_lifetime"];
    if (maximum) {
      const ms =
        typeof maximum === "number" ? maximum * 1000 : Date.parse(maximum);
      if (Number.isFinite(ms)) session.maximumExpiresAt = ms;
    }
  } catch {
    /* Rogers can return opaque tokens; use observed expirytime instead. */
  }
  if (session.expiresAt) session.refreshAfter = session.expiresAt - 120_000;
}
