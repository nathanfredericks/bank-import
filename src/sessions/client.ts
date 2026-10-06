import { formatISO, subDays } from "date-fns";
import { request, type APIRequestContext } from "playwright-core";
import { EQHistory } from "../banks/eq-bank/history";
import { SummaryResponse } from "../banks/nbdb/schemas";
import {
  AccountResponse,
  TransactionsResponse,
} from "../banks/rogers-bank/schemas";
import { BankName } from "../banks/types";
import { SessionStore } from "./store";
import { restoreRogersTokens } from "./rogers";
import { renewNBDB } from "./nbdb";
import { BankFailure, tokenTiming, type BankSession } from "./types";

export class BankTransport {
  private rotationPending = false;
  private constructor(
    private session: BankSession,
    private client: APIRequestContext,
  ) {}
  static async open(session: BankSession) {
    if (session.bank === BankName.RogersBank) restoreRogersTokens(session);
    return new BankTransport(
      session,
      await request.newContext({
        storageState: session.state,
        timeout: 15_000,
        ignoreHTTPSErrors: false,
      }),
    );
  }
  async close() {
    await this.client.dispose();
  }
  private async json(
    url: string,
    headers = this.session.headers,
    body?: Record<string, string>,
    form = false,
  ) {
    let response;
    try {
      response = await this.client.fetch(url, {
        method: body ? "POST" : "GET",
        headers,
        maxRedirects: 0,
        ...(body ? (form ? { form: body } : { data: body }) : {}),
      });
    } catch {
      throw new BankFailure("transport-failed");
    }
    const status = response.status();
    console.info(
      JSON.stringify({
        event: "bank-api-response",
        bank: this.session.bank,
        operation: body
          ? "renewal"
          : url.includes("transactions")
            ? "history"
            : "accounts",
        status,
      }),
    );
    if ([401, 419, 440].includes(status) || (status >= 300 && status < 400))
      throw new BankFailure("authentication-required");
    if (status === 429) throw new BankFailure("throttled");
    if (!response.ok()) {
      if (body && [400, 403].includes(status)) {
        const error = await response.json().catch(() => ({}));
        if (
          [
            "invalid_grant",
            "invalid_token",
            "login_required",
            "session_expired",
          ].includes(error?.error)
        )
          throw new BankFailure("authentication-required");
      }
      throw new BankFailure("transport-failed");
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new BankFailure("invalid-response");
    }
    if (body && this.session.bank === BankName.RogersBank)
      console.info(
        JSON.stringify({
          event: "bank-renewal-response",
          bank: this.session.bank,
          expired: String(data?.status) === "440",
          bodyKeys: Object.keys(data ?? {}),
          tokenReturned: !!response.headers().accesstoken,
          refreshReturned: !!response.headers().refreshtoken,
          tokenChanged:
            !!response.headers().accesstoken &&
            response.headers().accesstoken !== this.session.headers.accesstoken,
        }),
      );
    if (String(data?.status) === "440")
      throw new BankFailure("authentication-required");
    const rotated = response.headers();
    if (this.session.bank === BankName.RogersBank) {
      if (rotated.accesstoken) {
        this.rotationPending ||=
          rotated.accesstoken !== this.session.headers.accesstoken;
        this.session.headers.accesstoken = rotated.accesstoken;
        this.session.headers.authorization = `Bearer ${rotated.accesstoken}`;
      }
      if (rotated.refreshtoken) {
        this.rotationPending ||=
          rotated.refreshtoken !== this.session.headers.refreshtoken;
        this.session.headers.refreshtoken = rotated.refreshtoken;
      }
      if (rotated.expirytime) {
        const value = Number(rotated.expirytime);
        this.session.expiresAt = Number.isFinite(value)
          ? value < 1e12
            ? value * 1000
            : value
          : Date.parse(rotated.expirytime);
      }
    }
    return data;
  }
  async renew() {
    const s = this.session;
    if (s.maximumExpiresAt && Date.now() >= s.maximumExpiresAt)
      throw new BankFailure("authentication-required");
    if (s.bank === BankName.RogersBank) {
      if (
        !s.headers.accesstoken ||
        !s.headers.refreshtoken ||
        !s.headers.deviceid ||
        !s.accountId ||
        !s.customerId
      )
        throw new BankFailure("authentication-required");
      await this.json(
        "https://selfserve.apis.rogersbank.com/v1/authenticate/regeneratetoken/",
        s.headers,
        {
          accountId: s.accountId,
          customerId: s.customerId,
          deviceId: s.headers.deviceid,
          channel: s.headers.channel!,
          accesstoken: s.headers.accesstoken,
          refreshtoken: s.headers.refreshtoken,
          flow: "PATH_REGEN_TOKEN_API",
        },
      );
      // Rogers may return the existing pair until its renewal window opens.
      // A successful no-op must not force an otherwise valid session to log in.
      if (s.expiresAt && s.expiresAt <= Date.now())
        throw new BankFailure("authentication-required");
    } else if (s.bank === BankName.NBDB && s.authorization && !s.refresh) {
      const data = await renewNBDB(s, this.client, (url, headers, body) =>
        this.json(url, headers, body, true),
      );
      s.headers.authorization = `Bearer ${data.access_token}`;
    } else {
      const renewal = s.refresh;
      if (!renewal) throw new BankFailure("authentication-required");
      const url = new URL(renewal.url);
      const allowed =
        s.bank === BankName.EQBank
          ? url.origin === "https://api.eqbank.ca" &&
            url.pathname === "/auth/v3/access-token"
          : url.origin === "https://api.bnc.ca" &&
            /^\/bnc\/prod-okta\/sso\/oauth2\/[^/]+\/v1\/token$/.test(
              url.pathname,
            );
      if (!allowed || renewal.body.grant_type !== "refresh_token")
        throw new BankFailure("invalid-response");
      const headers = { ...renewal.headers, ...s.headers };
      if (s.bank === BankName.NBDB)
        headers["content-type"] = "application/x-www-form-urlencoded";
      const data = await this.json(
        renewal.url,
        headers,
        renewal.body,
        s.bank === BankName.NBDB,
      );
      if (typeof data.access_token !== "string")
        throw new BankFailure("authentication-required");
      s.headers.authorization = `Bearer ${data.access_token}`;
      if (s.headers.accesstoken) s.headers.accesstoken = data.access_token;
      if (data.refresh_token) renewal.body.refresh_token = data.refresh_token;
      if (typeof data.expires_in === "number")
        s.expiresAt = Date.now() + data.expires_in * 1000;
    }
    tokenTiming(s);
    console.info(
      JSON.stringify({
        event: "session-renewed",
        bank: s.bank,
        expiresAt: s.expiresAt,
      }),
    );
  }
  async persist(owner: string) {
    tokenTiming(this.session);
    this.session.state = await this.client.storageState();
    this.session.savedAt = new Date().toISOString();
    await new SessionStore().saveSession(this.session, owner);
    this.rotationPending = false;
  }
  async persistRotation(owner: string) {
    if (this.rotationPending) await this.persist(owner);
  }
  async fetchData(validateOnly = false) {
    const s = this.session;
    if (s.bank === BankName.EQBank) {
      const history = new EQHistory((path, headers) =>
        this.json(`https://web-api.eqbank.ca/web/v1.1${path}`, {
          ...s.headers,
          ...headers,
        }),
      );
      const namespace =
        process.env.UUID_NAMESPACE ?? "f47ac10b-58cc-4372-a567-0e02b2c3d479";
      if (validateOnly) {
        await history.validateAccounts(namespace);
        return { records: [] };
      }
      return {
        records: await history.retrieve(
          process.env.EQ_START_DATE ?? "2026-10-02",
          namespace,
        ),
      };
    }
    if (s.bank === BankName.RogersBank) {
      if (!/^\d+$/.test(s.accountId ?? "") || !/^\d+$/.test(s.customerId ?? ""))
        throw new BankFailure("invalid-response");
      const base = `https://selfserve.apis.rogersbank.com/corebank/v1/account/${s.accountId}/customer/${s.customerId}`;
      const account = AccountResponse.parse(await this.json(`${base}/detail`));
      if (
        account._accountId !== s.accountId ||
        account._customerId !== s.customerId
      )
        throw new BankFailure("invalid-response");
      if (validateOnly)
        return {
          accounts: [
            {
              id: account.id,
              name: account.name,
              balance: account.balance,
              transactions: [],
            },
          ],
        };
      const query = new URLSearchParams({
        fromDate: formatISO(subDays(new Date(), 10), {
          representation: "date",
        }),
        toDate: formatISO(new Date(), { representation: "date" }),
      });
      const transactions = TransactionsResponse.parse(
        await this.json(`${base}/transactions?${query}`),
      );
      return {
        accounts: [
          {
            id: account.id,
            name: account.name,
            balance: account.balance,
            transactions,
          },
        ],
      };
    }
    if (s.bank !== BankName.NBDB || !s.endpoint)
      throw new BankFailure("invalid-response");
    const url = new URL(s.endpoint);
    if (
      url.origin !== "https://iiroc.investments.apis.bnc.ca" ||
      url.pathname !== "/orion-api/v1/1/portfolios/summary"
    )
      throw new BankFailure("invalid-response");
    return { accounts: SummaryResponse.parse(await this.json(s.endpoint)) };
  }
}
