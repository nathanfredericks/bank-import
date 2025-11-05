import { convert } from "html-to-text";
import pRetry from "p-retry";
import { z } from "zod";
import env from "./env";
import logger from "./logger";
import secrets from "./secrets";

const TWO_FACTOR_AUTHENTICATION_CODE_REGEX = /\b\d{6}\b/;

const SessionSchema = z.object({
  capabilities: z.record(z.string(), z.any()),
  accounts: z.record(
    z.string(),
    z.object({
      name: z.string(),
      isPersonal: z.boolean(),
      isReadOnly: z.boolean(),
      accountCapabilities: z.record(z.string(), z.any()),
    }),
  ),
  apiUrl: z.string().url(),
  downloadUrl: z.string(),
  uploadUrl: z.string(),
  eventSourceUrl: z.string(),
  state: z.string(),
});

const EmailBodyPartSchema = z.object({
  partId: z.string(),
  blobId: z.string(),
  type: z.string().optional(),
});

const EmailSchema = z.object({
  id: z.string(),
  htmlBody: z.array(EmailBodyPartSchema).optional(),
  textBody: z.array(EmailBodyPartSchema).optional(),
});

const EmailQueryResponseSchema = z.object({
  accountId: z.string(),
  queryState: z.string(),
  canCalculateChanges: z.boolean(),
  position: z.number(),
  ids: z.array(z.string()),
});

const EmailGetResponseSchema = z.object({
  accountId: z.string(),
  state: z.string(),
  list: z.array(EmailSchema),
  notFound: z.array(z.string()),
});

const EmailSetResponseSchema = z.object({
  accountId: z.string(),
  newState: z.string(),
  destroyed: z.array(z.string()).optional(),
});

const JmapResponseSchema = z.object({
  methodResponses: z.array(z.tuple([z.string(), z.any(), z.string()])),
  sessionState: z.string(),
});

type Session = z.infer<typeof SessionSchema>;

let cachedSession: Session | null = null;

async function getSession(): Promise<Session> {
  if (cachedSession) {
    return cachedSession;
  }

  const response = await fetch(env.JMAP_SESSION_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secrets.JMAP_BEARER_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch JMAP session: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  cachedSession = SessionSchema.parse(data);
  return cachedSession;
}

async function jmapRequest(methodCalls: Array<[string, any, string]>) {
  const session = await getSession();

  const response = await fetch(session.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secrets.JMAP_BEARER_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `JMAP request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return JmapResponseSchema.parse(data);
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
  return pRetry(
    async () => {
      logger.debug("Fetching emails");
      const session = await getSession();
      const accountId = Object.keys(session.accounts)[0];

      const queryResponse = await jmapRequest([
        [
          "Email/query",
          {
            accountId,
            filter: {
              after: afterDate.toISOString(),
              from: sender,
              subject: subject,
            },
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: 1,
          },
          "q1",
        ],
      ]);

      const [queryMethodName, queryMethodResponse] =
        queryResponse.methodResponses[0];

      if (queryMethodName === "error") {
        throw new Error(
          `Email/query error: ${JSON.stringify(queryMethodResponse)}`,
        );
      }

      const queryData = EmailQueryResponseSchema.parse(queryMethodResponse);
      const emailIds = queryData.ids;

      if (!emailIds || emailIds.length === 0) {
        logger.debug("No emails found");
        throw new Error("No emails found");
      }

      const getResponse = await jmapRequest([
        [
          "Email/get",
          {
            accountId,
            ids: emailIds,
            properties: ["htmlBody", "textBody"],
          },
          "g1",
        ],
      ]);

      const [getMethodName, getMethodResponse] = getResponse.methodResponses[0];

      if (getMethodName === "error") {
        throw new Error(
          `Email/get error: ${JSON.stringify(getMethodResponse)}`,
        );
      }

      const getData = EmailGetResponseSchema.parse(getMethodResponse);
      const email = getData.list[0];

      if (!email) {
        logger.debug("No email data found");
        throw new Error("No email data found");
      }

      let text: string | null = null;

      if (email.htmlBody && email.htmlBody.length > 0) {
        const htmlBody = email.htmlBody[0];
        const downloadUrl = session.downloadUrl
          .replace("{accountId}", accountId)
          .replace("{blobId}", htmlBody.blobId)
          .replace("{name}", "")
          .replace("{type}", htmlBody.type || "text/html");

        const blobResponse = await fetch(downloadUrl, {
          headers: {
            Authorization: `Bearer ${secrets.JMAP_BEARER_TOKEN}`,
          },
        });

        if (!blobResponse.ok) {
          throw new Error(
            `Failed to download HTML body: ${blobResponse.status} ${blobResponse.statusText}`,
          );
        }

        const html = await blobResponse.text();
        text = convert(html, {
          selectors: [
            { selector: "a", options: { ignoreHref: true } },
            { selector: "img", format: "skip" },
          ],
        });
      }

      if (!text && email.textBody && email.textBody.length > 0) {
        const textBody = email.textBody[0];
        const downloadUrl = session.downloadUrl
          .replace("{accountId}", accountId)
          .replace("{blobId}", textBody.blobId)
          .replace("{name}", "")
          .replace("{type}", textBody.type || "text/plain");

        const blobResponse = await fetch(downloadUrl, {
          headers: {
            Authorization: `Bearer ${secrets.JMAP_BEARER_TOKEN}`,
          },
        });

        if (!blobResponse.ok) {
          throw new Error(
            `Failed to download text body: ${blobResponse.status} ${blobResponse.statusText}`,
          );
        }

        text = await blobResponse.text();
      }

      if (!text) {
        logger.debug("No email body found");
        throw new Error("No email body found");
      }

      const code = text.match(regex)?.[0];
      if (!code) {
        logger.debug("2FA code not found in email");
        throw new Error("2FA code not found");
      }

      logger.debug("Found 2FA code, deleting email");

      try {
        const deleteResponse = await jmapRequest([
          [
            "Email/set",
            {
              accountId,
              destroy: emailIds,
            },
            "d1",
          ],
        ]);

        const [deleteMethodName, deleteMethodResponse] =
          deleteResponse.methodResponses[0];

        if (deleteMethodName === "error") {
          logger.error(
            "Failed to delete email",
            JSON.stringify(deleteMethodResponse),
          );
        } else {
          EmailSetResponseSchema.parse(deleteMethodResponse);
          logger.debug("Email deleted successfully");
        }
      } catch (deleteError) {
        logger.error("Failed to delete email", deleteError);
      }

      return code;
    },
    {
      retries: 60,
      minTimeout: 1000,
      maxTimeout: 1000,
    },
  );
}

export { getEmailTwoFactorAuthenticationCode };
