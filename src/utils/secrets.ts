import {
  GetSecretValueCommand,
  SecretsManagerClient,
  SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import env from "./env";

const config: SecretsManagerClientConfig = {};
if (
  env.AWS_ACCESS_KEY_ID &&
  env.AWS_SECRET_ACCESS_KEY &&
  env.AWS_DEFAULT_REGION
) {
  config.region = env.AWS_DEFAULT_REGION;
  config.credentials = {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}
const secretsManagerClient = new SecretsManagerClient(config);
const { SecretString } = await secretsManagerClient.send(
  new GetSecretValueCommand({
    SecretId: env.SECRET_NAME,
  }),
);

const Secrets = z.object({
  BMO_CARD_NUMBER: z.string(),
  BMO_PASSWORD: z.string(),
  ROGERS_BANK_USERNAME: z.string(),
  ROGERS_BANK_PASSWORD: z.string(),
  NBDB_USER_ID: z.string(),
  NBDB_PASSWORD: z.string(),
  YNAB_ACCESS_TOKEN: z.string(),
  JMAP_BEARER_TOKEN: z.string(),
  PUSHOVER_TOKEN: z.string(),
  PUSHOVER_USER: z.string(),
});

const secretJson = JSON.parse(SecretString || "{}");

export default Secrets.parse(secretJson);
