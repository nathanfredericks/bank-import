import { z } from "zod";

export const EQ_ACCOUNTS = {
  "130742998": "50ef2940-404a-5073-8472-5e0f6bd3c398",
  "302911525": "13a60c53-989f-5c2e-88bd-6eddacd972be",
} as const;

export const EQJob = z.object({
  version: z.literal(1),
  jobId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  requestId: z.string().min(1),
  source: z.enum(["alert", "scheduled", "manual"]),
  dryRun: z.boolean(),
  messageId: z.string().optional(),
  alertAmount: z.number().int().positive().optional(),
  alertDate: z.string().date().optional(),
});

export type EQRecord = {
  accountId: string;
  accountNumber: string;
  bankId: string | null;
  provisionalId: string;
  references: string[];
  amount: number;
  date: string;
  description: string;
  status: "pending" | "posted";
  originalAmount: number | null;
  originalCurrency: string | null;
};

export function milliunits(value: string): number {
  if (!/^-?\d+(?:\.\d{1,3})?$/.test(value))
    throw new Error("Invalid bank amount");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const amount = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  if (!Number.isSafeInteger(amount))
    throw new Error("Bank amount out of range");
  return negative ? -amount : amount;
}

export function bankDate(value: string): string {
  // EQ displays this calendar date. Card timestamps are not trustworthy UTC instants.
  return z.string().date().parse(value.slice(0, 10));
}
