import { expect, test } from "bun:test";
import { readEmailCode } from "../src/utils/email";

const sessionUrl = "https://api.fastmail.com/jmap/session";
const apiUrl = "https://phl.api.fastmail.com/jmap/api/";
const afterDate = new Date("2026-09-05T23:12:05Z");
const challenge = {
  afterDate,
  sender: "noreply@appbnc.ca",
  subject: "Here’s your verification code",
  codeLength: 6,
};

function jmap(method: string, data: unknown) {
  return Response.json({ methodResponses: [[method, data, "request"]] });
}

test("queries by receipt time and filters sender and subject locally", async () => {
  const requestFilters: unknown[] = [];
  const mockFetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (!init?.body)
      return Response.json({
        apiUrl,
        primaryAccounts: { "urn:ietf:params:jmap:mail": "mail-account" },
      });

    const request = JSON.parse(String(init.body));
    const [method, args] = request.methodCalls[0];
    if (method === "Email/query") {
      requestFilters.push(args.filter);
      return jmap(method, { ids: ["unrelated", "target"] });
    }
    if (args.properties.includes("receivedAt")) {
      return jmap(method, {
        list: [
          {
            id: "unrelated",
            receivedAt: "2026-09-05T23:12:10Z",
            subject: "Something else",
            from: [{ email: "other@example.com" }],
          },
          {
            id: "target",
            receivedAt: "2026-09-05T23:12:11Z",
            subject: challenge.subject,
            from: [{ email: "NOREPLY@appbnc.ca" }],
          },
        ],
      });
    }
    expect(args.ids).toEqual(["target"]);
    return jmap(method, {
      list: [
        {
          id: "target",
          textBody: [{ partId: "text" }],
          htmlBody: [],
          bodyValues: {
            text: { value: "Your verification code is 123456." },
          },
        },
      ],
    });
  };

  await expect(
    readEmailCode(challenge, {
      sessionUrl,
      token: "test-token",
      fetch: mockFetch as typeof fetch,
      timeoutMs: 100,
      pollMs: 1,
    }),
  ).resolves.toBe("123456");
  expect(requestFilters).toEqual([{ after: afterDate.toISOString() }]);
});

test("reports only safe candidate and match counts when polling times out", async () => {
  const mockFetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (!init?.body)
      return Response.json({
        apiUrl,
        primaryAccounts: { "urn:ietf:params:jmap:mail": "mail-account" },
      });

    const request = JSON.parse(String(init.body));
    const [method, args] = request.methodCalls[0];
    if (method === "Email/query") return jmap(method, { ids: ["one", "two"] });
    return jmap(method, {
      list: args.ids.map((id: string) => ({
        id,
        receivedAt: "2026-09-05T23:12:11Z",
        subject: "Unrelated message",
        from: [{ email: "other@example.com" }],
      })),
    });
  };

  await expect(
    readEmailCode(challenge, {
      sessionUrl,
      token: "test-token",
      fetch: mockFetch as typeof fetch,
      timeoutMs: 20,
      pollMs: 1,
    }),
  ).rejects.toThrow(
    "Verification email timed out (recent candidates: 2; matching messages: 0)",
  );
});
