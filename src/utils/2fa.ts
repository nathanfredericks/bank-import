import { tz } from "@date-fns/tz";
import axios from "axios";
import { format } from "date-fns";
import { convert } from "html-to-text";
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
      const { data } = await axios.get("https://voip.ms/api/v1/rest.php", {
        params: {
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
        },
      });
      const {
        status,
        sms: [{ message }],
      } = Response.parse(data);
      if (status === "no_sms") {
        logger.debug("No SMS/MMS messages found", message);
        throw new Error("No SMS/MMS messages found");
      }
      if (status !== "success") {
        logger.notice("Error fetching SMS/MMS messages", status);
        throw new Error(`Error fetching SMS/MMS messages: ${status}`);
      }
      const code = message.match(TWO_FACTOR_AUTHENTICATION_CODE_REGEX)?.[0];
      if (!code) {
        logger.error("2FA code not found", message);
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

export {
  getEmailTwoFactorAuthenticationCode,
  getSMSTwoFactorAuthenticationCode,
};
