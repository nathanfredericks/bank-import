import { readEmailCode, type EmailChallenge } from "./email";
import env from "./env";
import secrets from "./secrets";

export function getEmailTwoFactorAuthenticationCode(challenge: EmailChallenge) {
  return readEmailCode(challenge, {
    sessionUrl: env.JMAP_SESSION_URL,
    token: secrets.JMAP_BEARER_TOKEN,
  });
}
