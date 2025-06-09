import { config } from "@dotenvx/dotenvx";
import { z } from "zod";
import { BankName } from "../banks/types";

const env = config({
  quiet: true,
});

const Env = z.object({
  YNAB_BUDGET_ID: z.string(),
  DEBUG: z.coerce.boolean().optional(),
  TZ: z.string(),
  UUID_NAMESPACE: z.string(),
  JMAP_SESSION_URL: z.string(),
  SECRET_NAME: z.string(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_DEFAULT_REGION: z.string().optional(),
  BANK: z.nativeEnum(BankName),
  AWS_S3_BUCKET_NAME: z.string().optional(),
  PROXY_SERVER: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),
});

export default Env.parse({
  ...process.env,
  ...env.parsed,
});
