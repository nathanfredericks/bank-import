import type { BrowserContext, Response } from "playwright-core";
import { BankName } from "../banks/types";
import { restoreRogersTokens } from "./rogers";
import { SessionStore } from "./store";
import { authenticationHeaders, tokenTiming, type BankSession } from "./types";

export class SessionCapture {
  private pending = new Set<Promise<void>>();
  private captured: Partial<BankSession> = {};
  private error = false;
  constructor(
    private bank: BankName,
    private context: BrowserContext,
  ) {
    context.on("response", (response) => {
      const work = this.observe(response).catch(() => {
        this.error = true;
      });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    });
  }
  private async observe(response: Response) {
    if (!response.ok()) return;
    const url = new URL(response.url());
    if (
      this.bank === BankName.NBDB &&
      url.origin === "https://api.bnc.ca" &&
      /\/sso\//.test(url.pathname)
    ) {
      // Protocol metadata only: never retain password/OTP POST bodies or token URLs.
      const observations = (this.captured.authenticationObserved ??= []);
      observations.push({
        path: url.pathname,
        method: response.request().method(),
        status: response.status(),
        fields: [...url.searchParams.keys()],
      });
    }
    const discovery =
      this.bank === BankName.EQBank
        ? url.origin === "https://web-api.eqbank.ca" &&
          url.pathname === "/web/v1.1/accounts/v2/accounts"
        : this.bank === BankName.RogersBank
          ? url.origin === "https://selfserve.apis.rogersbank.com" &&
            /^\/corebank\/v1\/account\/\d+\/customer\/\d+\/detail$/.test(
              url.pathname,
            )
          : url.origin === "https://iiroc.investments.apis.bnc.ca" &&
            url.pathname === "/orion-api/v1/1/portfolios/summary";
    if (discovery && response.request().method() === "GET") {
      this.captured.headers = {
        ...this.captured.headers,
        ...authenticationHeaders(await response.request().allHeaders()),
      };
      this.captured.endpoint = url.toString();
      if (this.bank === BankName.RogersBank) {
        const parts = url.pathname.match(/account\/(\d+)\/customer\/(\d+)/)!;
        this.captured.accountId = parts[1];
        this.captured.customerId = parts[2];
      }
    }
    const eqAuth =
      url.origin === "https://api.eqbank.ca" &&
      url.pathname === "/auth/v3/access-token";
    const rogersAuth =
      url.origin === "https://selfserve.apis.rogersbank.com" &&
      url.pathname.startsWith("/v1/authenticate/");
    const nbdbToken =
      url.origin === "https://api.bnc.ca" &&
      /\/oauth2\/[^/]+\/v1\/token$/.test(url.pathname);
    if (!eqAuth && !rogersAuth && !nbdbToken) return;
    if (eqAuth || nbdbToken) {
      const text = response.request().postData() ?? "";
      let body: Record<string, string>;
      try {
        body = JSON.parse(text);
      } catch {
        body = Object.fromEntries(new URLSearchParams(text));
      }
      if ((eqAuth && body.client_id) || body.grant_type === "refresh_token") {
        const allowed = eqAuth
          ? ["client_id"]
          : ["client_id", "refresh_token", "scope"];
        this.captured.refresh = {
          url: url.toString(),
          headers: authenticationHeaders(await response.request().allHeaders()),
          body: {
            grant_type: "refresh_token",
            ...Object.fromEntries(
              allowed
                .filter((k) => typeof body[k] === "string")
                .map((k) => [k, body[k]!]),
            ),
          },
        };
      }
      if (nbdbToken) {
        const data = await response.json();
        if (
          body.grant_type === "authorization_code" &&
          body.client_id &&
          body.redirect_uri &&
          typeof data.scope === "string"
        )
          this.captured.authorization = {
            tokenUrl: url.toString(),
            clientId: body.client_id,
            redirectUri: body.redirect_uri,
            scope: data.scope,
            headers: authenticationHeaders(
              await response.request().allHeaders(),
            ),
          };
        if (data.refresh_token && body.client_id)
          this.captured.refresh = {
            url: url.toString(),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: {
              grant_type: "refresh_token",
              client_id: body.client_id,
              refresh_token: data.refresh_token,
              ...(body.scope ? { scope: body.scope } : {}),
            },
          };
      }
    }
    if (rogersAuth) {
      const headers = await response.allHeaders();
      // Keep rotated tokens even if the discovery request raced the auth response.
      const next = this.captured.headers ?? {};
      if (headers.accesstoken) {
        next.accesstoken = headers.accesstoken;
        next.authorization = `Bearer ${headers.accesstoken}`;
      }
      if (headers.refreshtoken) next.refreshtoken = headers.refreshtoken;
      if (Object.keys(next).length) this.captured.headers = next;
      if (headers.expirytime) {
        const value = Number(headers.expirytime);
        this.captured.expiresAt = Number.isFinite(value)
          ? value < 1e12
            ? value * 1000
            : value
          : Date.parse(headers.expirytime);
      }
    }
  }
  async save() {
    if (!process.env.SESSION_TABLE || !process.env.BANK_JOB_ID) return;
    await Promise.all([...this.pending]);
    if (!this.captured.endpoint || !this.captured.headers || this.error)
      throw new Error("Bank authentication capture incomplete");
    const sessions: Record<string, Record<string, string>> = {};
    for (const page of this.context.pages()) {
      const origin = new URL(page.url()).origin;
      if (origin === "null") continue;
      sessions[origin] = await page.evaluate(() =>
        Object.fromEntries(Object.entries(sessionStorage)),
      );
    }
    const session: BankSession = {
      version: 1,
      bank: this.bank,
      savedAt: new Date().toISOString(),
      state: await this.context.storageState(),
      sessions,
      headers: this.captured.headers,
      ...this.captured,
    };
    tokenTiming(session);
    if (this.bank === BankName.RogersBank) restoreRogersTokens(session);
    await new SessionStore().saveSession(session, process.env.BANK_JOB_ID);
    console.info(
      JSON.stringify({
        event: "session-captured",
        bank: this.bank,
        expiresAt: session.expiresAt,
        renewalCaptured:
          !!session.refresh ||
          !!session.authorization ||
          !!session.headers.refreshtoken,
      }),
    );
  }
}
