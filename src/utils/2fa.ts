import { convert } from "html-to-text";
import { JamClient } from "jmap-jam";
import { retry } from "ts-retry-promise";
import env from "./env";
import logger from "./logger";
import secrets from "./secrets";

const jam = new JamClient({
  sessionUrl: env.JMAP_SESSION_URL,
  bearerToken: secrets.JMAP_BEARER_TOKEN,
});
const TWO_FACTOR_AUTHENTICATION_CODE_REGEX = /\b\d{6}\b|\b\d{8}\b/;

async function getEmailTwoFactorAuthenticationCode(
  afterDate: Date,
  sender?: string,
  subject?: string,
) {
  return retry(
    async () => {
      logger.debug("Fetching emails");
      const accountId = await jam.getPrimaryAccount();
      const [
        {
          emails: {
            list: [email],
          },
        },
      ] = await jam.requestMany((t) => {
        const emailIds = t.Email.query({
          accountId,
          filter: {
            after: afterDate.toISOString(),
            ...(sender ? { from: sender } : {}),
            ...(subject ? { subject } : {}),
          },
          limit: 1,
        });
        const emails = t.Email.get({
          accountId,
          ids: emailIds.$ref("/ids"),
          properties: ["htmlBody"],
        });
        return { emailIds, emails };
      });
      if (!email) {
        logger.debug("No emails found");
        throw new Error("No emails found");
      }
      const {
        htmlBody: [htmlBody],
      } = email;
      const response = await jam.downloadBlob({
        accountId,
        blobId: htmlBody.blobId!,
        mimeType: htmlBody.type,
        fileName: "",
      });
      const html = await response.text();
      const text = convert(html, {
        selectors: [
          { selector: "a", options: { ignoreHref: true } },
          {
            selector: "img",
            format: "skip",
          },
        ],
      });
      const code = text.match(TWO_FACTOR_AUTHENTICATION_CODE_REGEX)?.[0];
      if (!code) {
        logger.debug("2FA code not found" + text);
        throw new Error("2FA code not found");
      }
      logger.debug("Fetched 2FA code");
      return code;
    },
    {
      retries: "INFINITELY",
      delay: 1000,
      timeout: 60 * 1000,
    },
  );
}

export { getEmailTwoFactorAuthenticationCode };
