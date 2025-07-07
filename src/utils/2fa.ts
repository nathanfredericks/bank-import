import { GaxiosError } from "gaxios";
import { gmail_v1, google } from "googleapis";
import { convert } from "html-to-text";
import logger from "./logger";
import secrets from "./secrets";

const TWO_FACTOR_AUTHENTICATION_CODE_REGEX = /\b\d{6}\b/;

const serviceAccountKey = JSON.parse(secrets.GOOGLE_SERVICE_ACCOUNT_KEY);

const auth = new google.auth.JWT({
  email: serviceAccountKey.client_email,
  key: serviceAccountKey.private_key,
  scopes: ["https://mail.google.com/"],
  subject: secrets.GMAIL_USER,
});

const gmailClient = google.gmail({
  version: "v1",
  auth,
});

function findText(part: gmail_v1.Schema$MessagePart): string | null {
  if (part.body?.data) {
    const data = Buffer.from(part.body.data, "base64").toString("utf8");
    if (part.mimeType === "text/html") {
      return convert(data, {
        selectors: [
          { selector: "a", options: { ignoreHref: true } },
          { selector: "img", format: "skip" },
        ],
      });
    }
    return data;
  }

  if (part.mimeType === "multipart/alternative" && part.parts) {
    const plainPart = part.parts.find((p) => p.mimeType === "text/plain");
    if (plainPart) {
      const text = findText(plainPart);
      if (text) return text;
    }
    const htmlPart = part.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart) {
      const text = findText(htmlPart);
      if (text) return text;
    }
  }

  if (part.parts) {
    for (const subPart of part.parts) {
      const text = findText(subPart);
      if (text) return text;
    }
  }

  return null;
}

type GetEmailTwoFactorAuthenticationCodeParams = {
  afterDate: Date;
  sender: string;
  subject: string;
  regex?: RegExp;
};

async function getEmailTwoFactorAuthenticationCode({
  afterDate,
  sender,
  subject,
  regex = TWO_FACTOR_AUTHENTICATION_CODE_REGEX,
}: GetEmailTwoFactorAuthenticationCodeParams) {
  const startTime = Date.now();
  const maxRetryTime = 60 * 1000; // 1 minute
  const retryInterval = 1000; // 1 second
  const maxEmailAge = 5 * 60 * 1000; // 5 minutes

  while (Date.now() - startTime < maxRetryTime) {
    try {
      logger.debug("Fetching emails from inbox");
      const query = `in:inbox from:${sender} subject:("${subject}")`;

      const messageList = await gmailClient.users.messages.list({
        userId: "me",
        q: query,
      });

      if (!messageList.data.messages?.length) {
        logger.debug("No emails found, retrying...");
        await new Promise(resolve => setTimeout(resolve, retryInterval));
        continue;
      }

      for (const message of messageList.data.messages) {
        if (!message.id) continue;

        const messageDetails = await gmailClient.users.messages.get({
          userId: "me",
          id: message.id,
        });

        if (!messageDetails.data.internalDate) continue;

        const emailDate = Number(messageDetails.data.internalDate);
        const currentTime = Date.now();
        
        if (emailDate < afterDate.getTime()) {
          continue;
        }

        if (currentTime - emailDate > maxEmailAge) {
          logger.debug(`Email is older than 5 minutes, skipping`);
          continue;
        }

        if (!messageDetails.data.payload) continue;

        const text = findText(messageDetails.data.payload);
        if (!text) continue;

        const code = text.match(regex)?.[0];
        if (code) {
          logger.debug("Found 2FA code, deleting email");
          
          try {
            await gmailClient.users.messages.delete({
              userId: "me",
              id: message.id,
            });
            logger.debug("Email deleted successfully");
          } catch (deleteError) {
            logger.error("Failed to delete email", deleteError);
          }
          
          return code;
        }
      }

      logger.debug("2FA code not found in current emails, retrying...");
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    } catch (error) {
      if (error instanceof GaxiosError) {
        logger.error("Error fetching emails", error.response?.data);
      }
      
      if (Date.now() - startTime > maxRetryTime - retryInterval) {
        throw error;
      }
      
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
  }

  throw new Error("2FA code not found within timeout period");
}

export { getEmailTwoFactorAuthenticationCode };
