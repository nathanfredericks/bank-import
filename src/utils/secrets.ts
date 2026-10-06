import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { text } from "node:stream/consumers";
import { z } from "zod";
// Use the SDK credential chain so temporary session tokens and ECS roles work.
const secretsManagerClient = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
});
const secretArn = z.string().min(1).parse(process.env.AWS_SECRET_ARN);
const localInput = process.env.LOCAL_SECRETS_STDIN === "true";
if (localInput && process.env.DRY_RUN !== "true") {
  throw new Error("Local secret input is allowed only for dry runs");
}
const SecretString = localInput
  ? await text(process.stdin)
  : (
      await secretsManagerClient.send(
        new GetSecretValueCommand({ SecretId: secretArn }),
      )
    ).SecretString;

const Secrets = z.object({
  ROGERS_BANK_USERNAME: z.string().min(1),
  ROGERS_BANK_PASSWORD: z.string().min(1),
  NBDB_USER_ID: z.string().min(1),
  NBDB_PASSWORD: z.string().min(1),
  PUSHOVER_TOKEN: z.string().min(1),
  PUSHOVER_USER: z.string().min(1),
  YNAB_ACCESS_TOKEN: z.string().min(1),
  JMAP_BEARER_TOKEN: z.string().min(1),
  EQ_BANK_USERNAME: z.string().min(1).optional(),
  EQ_BANK_PASSWORD: z.string().min(1).optional(),
});

const secretJson = JSON.parse(SecretString || "{}");

export default Secrets.parse(secretJson);
