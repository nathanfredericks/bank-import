import {
  GetSecretValueCommand,
  SecretsManagerClient,
  SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import env from "./env.js";

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
  VOIPMS_API_USERNAME: z.string(),
  VOIPMS_API_PASSWORD: z.string(),
  VOIPMS_DID: z.string(),
  TANGERINE_LOGIN_ID: z.string(),
  TANGERINE_PIN: z.string(),
  MANULIFE_BANK_USERNAME: z.string(),
  MANULIFE_BANK_PASSWORD: z.string(),
  BMO_CARD_NUMBER: z.string(),
  BMO_PASSWORD: z.string(),
  YNAB_ACCESS_TOKEN: z.string(),
  JMAP_BEARER_TOKEN: z.string(),
  ROGERS_BANK_USERNAME: z.string(),
  ROGERS_BANK_PASSWORD: z.string(),
});

const secretJson = JSON.parse(SecretString || "{}");

export default Secrets.parse(secretJson);
