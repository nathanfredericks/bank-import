import { z } from "zod";
import { BankName } from "./banks/types";

const boolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const Env = z
  .object({
    BANK: z.enum(BankName),
    TZ: z.string().default("America/Halifax"),
    DEBUG: boolean,
    DRY_RUN: boolean,
    UUID_NAMESPACE: z
      .string()
      .uuid()
      .default("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
    YNAB_BUDGET_ID: z.string().uuid(),
    YNAB_ADJUSTMENT_PAYEE_ID: z.string().uuid().optional(),
    NBDB_EXCLUDED_ACCOUNT_IDS: z.preprocess((value) => {
      if (value === undefined) return [];
      try {
        return JSON.parse(String(value));
      } catch {
        return value;
      }
    }, z.array(z.uuid())),
    JMAP_SESSION_URL: z.url().default("https://api.fastmail.com/jmap/session"),
    ROGERS_EMAIL_SENDER: z.email().optional(),
    ROGERS_EMAIL_SUBJECT: z.string().min(1).optional(),
    ROGERS_EMAIL_CODE_LENGTH: z.coerce.number().int().min(4).max(12).optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_DEFAULT_REGION: z.string().optional(),
    AWS_S3_TRACES_BUCKET_NAME: z.string().min(1),
    AWS_SECRET_ARN: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    const required =
      value.BANK === BankName.RogersBank
        ? ([
            "ROGERS_EMAIL_SENDER",
            "ROGERS_EMAIL_SUBJECT",
            "ROGERS_EMAIL_CODE_LENGTH",
          ] as const)
        : (["YNAB_ADJUSTMENT_PAYEE_ID"] as const);
    for (const key of required) {
      if (value[key] === undefined)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Required for selected bank",
        });
    }
  });

export function parseEnv(input: Record<string, string | undefined>) {
  const result = Env.safeParse(
    Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        value === "" ? undefined : value,
      ]),
    ),
  );
  if (!result.success) {
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  return result.data;
}
