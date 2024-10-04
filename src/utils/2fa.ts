import { tz } from "@date-fns/tz";
import { format } from "date-fns";
import { JamClient } from "jmap-jam";
import { retry } from "ts-retry-promise";
import env from "./env.js";
import logger from "./logger.js";
import secrets from "./secrets.js";
import { Response } from "./types.js";

const jam = new JamClient({
  sessionUrl: env.JMAP_SESSION_URL,
  bearerToken: secrets.JMAP_BEARER_TOKEN,
});
const TWO_FACTOR_AUTHENTICATION_CODE_REGEX = /\b\d{6}\b|\b\d{8}\b/;

function getSMSTwoFactorAuthenticationCode(afterDate: Date, sender?: string) {
  return retry(
    async () => {
      logger.debug("Fetching SMS/MMS messages");
      const response = await fetch(
        "https://voip.ms/api/v1/rest.php?" +
          new URLSearchParams({
            api_username: secrets.VOIPMS_API_USERNAME || "",
            api_password: secrets.VOIPMS_API_PASSWORD || "",
            method: "getSMS",
            did: secrets.VOIPMS_DID || "",
            limit: "1",
            all_messages: "1",
            from: format(afterDate, "yyyy-MM-dd HH:mm:ss", {
              in: tz("America/New_York"),
            }),
            ...(sender ? { contact: sender } : {}),
          }).toString(),
      );
      const json = await response.json();
      const { status, sms: messages } = Response.parse(json);
      if (status === "no_sms") {
        logger.debug("No SMS/MMS messages found", messages);
        throw new Error("No SMS/MMS messages found");
      }
      if (status !== "success") {
        logger.notice("Error fetching SMS/MMS messages", status);
        throw new Error(`Error fetching SMS/MMS messages: ${status}`);
      }
      const code = messages[0].message.match(
        TWO_FACTOR_AUTHENTICATION_CODE_REGEX,
      )?.[0];
      if (!code) {
        logger.error("2FA code not found", messages);
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

async function getEmailTwoFactorAuthenticationCode(
  afterDate: Date,
  sender?: string,
) {
  return retry(
    async () => {
      logger.debug("Fetching emails");
      const accountId = await jam.getPrimaryAccount();
      const [{ emails }] = await jam.requestMany((t) => {
        const emailIds = t.Email.query({
          accountId,
          filter: {
            after: afterDate.toISOString(),
            ...(sender ? { from: sender } : {}),
          },
          limit: 1,
        });
        const emails = t.Email.get({
          accountId,
          ids: emailIds.$ref("/ids"),
          properties: ["preview"],
        });
        return { emailIds, emails };
      });
      if (emails.list.length === 0) {
        logger.debug("No emails found");
        throw new Error("No emails found");
      }
      const message = emails.list[0].preview;
      const code = message.match(TWO_FACTOR_AUTHENTICATION_CODE_REGEX)?.[0];
      if (!code) {
        logger.debug("2FA code not found", message);
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

export {
  getEmailTwoFactorAuthenticationCode,
  getSMSTwoFactorAuthenticationCode,
};
