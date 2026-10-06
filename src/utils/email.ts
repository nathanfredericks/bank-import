import { convert } from "html-to-text";
import { z } from "zod";

function isFastmailEndpoint(value: string) {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === "api.fastmail.com" ||
      /^[a-z0-9-]+\.api\.fastmail\.com$/.test(url.hostname))
  );
}

const Session = z.object({
  apiUrl: z.url(),
  primaryAccounts: z.record(z.string(), z.string()),
});
const EmailMetadata = z.object({
  id: z.string(),
  receivedAt: z.string(),
  subject: z.string(),
  from: z.array(z.object({ email: z.string() })),
});
const EmailBody = z.object({
  id: z.string(),
  textBody: z.array(z.object({ partId: z.string() })).default([]),
  htmlBody: z.array(z.object({ partId: z.string() })).default([]),
  bodyValues: z.record(
    z.string(),
    z.object({ value: z.string(), isTruncated: z.boolean().optional() }),
  ),
});

export type EmailChallenge = {
  afterDate: Date;
  sender: string;
  subject: string;
  subjectPrefix?: boolean;
  codeLength: number;
};

export async function readEmailCode(
  challenge: EmailChallenge,
  options: {
    sessionUrl: string;
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<string> {
  if (
    !Number.isInteger(challenge.codeLength) ||
    challenge.codeLength < 4 ||
    challenge.codeLength > 12
  )
    throw new Error("Invalid verification code length");
  const request = options.fetch ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let candidateCount = 0;
  let matchingCount = 0;
  const timeoutError = () =>
    new Error(
      `Verification email timed out (recent candidates: ${candidateCount}; matching messages: ${matchingCount})`,
    );
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  };
  async function getJson(url: string, body?: unknown): Promise<any> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    const response = await request(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Email service request failed (HTTP ${response.status})`);
    return response.json();
  }
  if (!isFastmailEndpoint(options.sessionUrl))
    throw new Error("Unexpected email session origin");
  const session = Session.parse(await getJson(options.sessionUrl));
  // Fastmail's authenticated session can return a regional *.api.fastmail.com endpoint.
  if (!isFastmailEndpoint(session.apiUrl))
    throw new Error("Unexpected email API origin");
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!accountId) throw new Error("No primary mail account");
  async function call(method: string, args: Record<string, unknown>) {
    const result = await getJson(session.apiUrl, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [[method, { accountId, ...args }, "request"]],
    });
    const [name, data] = result.methodResponses?.[0] ?? [];
    if (name !== method) throw new Error(`Email service ${method} failed`);
    return data;
  }
  const pattern = new RegExp(
    `(?<!\\d)\\d{${challenge.codeLength}}(?!\\d)`,
    "g",
  );
  while (Date.now() < deadline) {
    const query = await call("Email/query", {
      filter: {
        after: challenge.afterDate.toISOString(),
        from: challenge.sender,
        subject: challenge.subject,
      },
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: 100,
    });
    const ids = z.array(z.string()).parse(query.ids);
    candidateCount = ids.length;
    if (ids.length) {
      const metadataResult = await call("Email/get", {
        ids,
        properties: ["id", "receivedAt", "subject", "from"],
      });
      const matchingEmails = z
        .array(EmailMetadata)
        .parse(metadataResult.list)
        .filter(
          (email) =>
            Date.parse(email.receivedAt) >= challenge.afterDate.getTime() &&
            (challenge.subjectPrefix
              ? email.subject.startsWith(challenge.subject)
              : email.subject === challenge.subject) &&
            email.from.some(
              (from) =>
                from.email.toLowerCase() === challenge.sender.toLowerCase(),
            ),
        )
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
      matchingCount = matchingEmails.length;
      if (matchingEmails.length) {
        const bodyResult = await call("Email/get", {
          ids: matchingEmails.map((email) => email.id),
          properties: ["id", "textBody", "htmlBody", "bodyValues"],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: 100_000,
        });
        const bodies = new Map(
          z
            .array(EmailBody)
            .parse(bodyResult.list)
            .map((email) => [email.id, email]),
        );
        for (const metadata of matchingEmails) {
          const email = bodies.get(metadata.id);
          if (!email) continue;
          const texts = [
            ...email.textBody.map((part) => email.bodyValues[part.partId]),
            ...email.htmlBody.map((part) => {
              const body = email.bodyValues[part.partId];
              return (
                body && {
                  ...body,
                  value: convert(body.value, {
                    selectors: [
                      { selector: "a", options: { ignoreHref: true } },
                      { selector: "img", format: "skip" },
                    ],
                  }),
                }
              );
            }),
          ];
          for (const body of texts) {
            if (!body || body.isTruncated) continue;
            const codes = [...new Set(body.value.match(pattern) ?? [])];
            if (codes.length === 1) return codes[0];
          }
        }
      }
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Math.min(options.pollMs ?? 1_000, deadline - Date.now())),
      ),
    );
  }
  throw timeoutError();
}
