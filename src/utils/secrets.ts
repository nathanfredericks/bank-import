import { z } from "zod";

const Secrets = z.object({
  BMO_LOGIN_ID: z.string(),
  BMO_PASSWORD: z.string(),
  ROGERS_BANK_USERNAME: z.string(),
  ROGERS_BANK_PASSWORD: z.string(),
  TANGERINE_USERNAME: z.string(),
  TANGERINE_PASSWORD: z.string(),
  NBDB_USER_ID: z.string(),
  NBDB_PASSWORD: z.string(),
  PUSHOVER_TOKEN: z.string(),
  PUSHOVER_USER: z.string(),
  YNAB_ACCESS_TOKEN: z.string(),
  JMAP_BEARER_TOKEN: z.string(),
});

export default Secrets.parse(Bun.env);
