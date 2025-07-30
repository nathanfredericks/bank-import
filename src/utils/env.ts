import { config } from "@dotenvx/dotenvx";
import { z } from "zod";
import { BankName } from "../banks/types";

const env = config({
  quiet: true,
  ignore: ["MISSING_ENV_FILE"],
});

const Env = z.object({
  TZ: z.string(),
  DEBUG: z.coerce.boolean().default(false),
  UUID_NAMESPACE: z.string().default("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
  YNAB_BUDGET_ID: z.string().default("last-used"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_DEFAULT_REGION: z.string().optional(),
  AWS_S3_TRACES_BUCKET_NAME: z.string(),
  AWS_S3_USER_DATA_BUCKET_NAME: z.string(),
  AWS_SECRET_ARN: z.string(),
  HTTP_PROXY: z.string().optional(),
  BANK: z.nativeEnum(BankName),
});

export default Env.parse({
  ...process.env,
  ...env.parsed,
});
