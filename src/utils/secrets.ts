import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
// Use the SDK credential chain so temporary session tokens and ECS roles work.
const secretsManagerClient = new SecretsManagerClient({
  region: Bun.env.AWS_REGION ?? Bun.env.AWS_DEFAULT_REGION,
});
const secretArn = z.string().min(1).parse(Bun.env.AWS_SECRET_ARN);
const localInput = Bun.env.LOCAL_SECRETS_STDIN === "true";
if (localInput && Bun.env.DRY_RUN !== "true") {
  throw new Error("Local secret input is allowed only for dry runs");
}
const SecretString = localInput
  ? await Bun.stdin.text()
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
});

const secretJson = JSON.parse(SecretString || "{}");

export default Secrets.parse(secretJson);
