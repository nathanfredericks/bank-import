import { z } from "zod";
import { BankName } from "../banks/types";

const Env = z.object({
  TZ: z.string(),
  DEBUG: z.coerce.boolean().default(false),
  UUID_NAMESPACE: z.string().default("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
  YNAB_BUDGET_ID: z.string().default("last-used"),
  JMAP_SESSION_URL: z.string().default("https://api.fastmail.com/jmap/session"),
  HEADLESS: z.coerce.boolean().default(false),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_DEFAULT_REGION: z.string().optional(),
  AWS_DYNAMODB_MESSAGES_TABLE_NAME: z.string(),
  AWS_DYNAMODB_PENDING_TRANSACTIONS_TABLE_NAME: z.string(),
  TRANSACTIONS_WEBHOOK_URL: z.string(),
  PENDING_NOTIFICATIONS_ENABLED: z.coerce.boolean().default(true),
  HTTP_PROXY: z.string().optional(),
  BANK: z.enum(BankName),
  TRACES_PATH: z.string(),
  USER_DATA_PATH: z.string(),
});

export default Env.parse(Bun.env);
