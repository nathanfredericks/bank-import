import type { Request } from "playwright-core";
import { z } from "zod";
import { getEmailTwoFactorAuthenticationCode } from "../../utils/2fa";
import env from "../../utils/env";
import logger from "../../utils/logger";
import { Bank } from "../Bank";
import { BankName } from "../types";
import { EQDiagnostics } from "./diagnostics";
import { EQHistory } from "./history";
import { readState, writeState } from "./store";
import type { EQRecord } from "./types";

const API = "https://web-api.eqbank.ca/web/v1.1";
const sessionKey = "session/browser-v1.json";
export class EQMaintenance extends Error {
  constructor() {
    super("EQ Bank is undergoing scheduled maintenance");
    this.name = "EQMaintenance";
  }
}

export class EQCredentialsRejected extends Error {
  constructor() {
    super(
      "EQ Bank rejected credentials; automatic login is paused until credentials are reviewed",
    );
  }
}

export class EQBank extends Bank {
  private headers: Record<string, string> = {};
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  constructor() {
    super(BankName.EQBank);
  }

  async retrieve(username: string, password: string): Promise<EQRecord[]> {
    const diagnostics = new EQDiagnostics();
    const progress = setInterval(
      () =>
        logger.debug(
          `EQ progress: ${this.diagnosticStage}`,
          diagnostics.resources(),
        ),
      30_000,
    );
    try {
      await this.launchBrowser({
        standardChromium: process.platform === "linux",
      });
      let page = await this.getPage();
      diagnostics.attach(page);
      const capture = async (request: Request) => {
        if (
          !request.url().startsWith(`${API}/accounts/v2/accounts`) ||
          request.method() !== "GET"
        )
          return;
        const headers = await request.allHeaders().catch(() => null);
        if (!headers) return;
        if (!headers.authorization || !headers.email) return;
        const response = await request.response().catch(() => null);
        if (!response?.ok()) return;
        this.headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([key]) =>
              !key.startsWith(":") &&
              !["host", "cookie", "content-length"].includes(key),
          ),
        );
        this.resolveReady?.();
      };
      page.on("request", capture);
      this.armHeaders();
      const restored =
        !env.EQ_FORCE_LOGIN &&
        process.env.BANK_FORCE_LOGIN !== "true" &&
        (await this.restoreSession());
      await page.goto("https://secure.eqbank.ca/dashboard");
      await this.checkMaintenance();
      const usable = restored && (await this.waitForHeaders(20_000));
      if (!usable) {
        await this.checkMaintenance();
        // A cold context removes stale Auth0 and EQ storage before one fresh login.
        await this.closeBrowser();
        await this.launchBrowser({
          standardChromium: process.platform === "linux",
        });
        page = await this.getPage();
        diagnostics.attach(page);
        page.on("request", capture);
        await page.goto("https://secure.eqbank.ca/");
        await this.checkMaintenance();
        this.armHeaders();
        let loginTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.login(username, password),
            new Promise<never>((_, reject) => {
              loginTimer = setTimeout(
                () =>
                  reject(new Error("EQ fresh login exceeded its time limit")),
                180_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(loginTimer);
        }
        if (!(await this.waitForHeaders(30_000)))
          throw new Error("EQ authenticated API headers were not received");
        logger.info("EQ fresh login completed");
      } else logger.info("EQ saved session restored in a new browser process");
      await this.saveSession();
      this.diagnosticStage = "history";
      const records = await new EQHistory((path, headers) =>
        this.json(path, headers),
      ).retrieve(env.EQ_START_DATE, env.UUID_NAMESPACE);
      await this.saveSession();
      logger.info(`EQ complete history: ${records.length} records`);
      await this.persistSession();
      return records;
    } catch (error) {
      if (
        !(error instanceof EQMaintenance) &&
        this.diagnosticStage.startsWith("login")
      ) {
        try {
          await this.checkMaintenance();
        } catch (classified) {
          if (classified instanceof EQMaintenance) error = classified;
        }
      }
      await writeState(
        `jobs/${env.EQ_JOB_ID}/transport-diagnostic.json`,
        diagnostics.snapshot(this.diagnosticStage, error),
      ).catch(() => {
        logger.warn("EQ transport diagnostic could not be saved");
      });
      if (["login-email", "login-password"].includes(this.diagnosticStage)) {
        // A private, masked page snapshot diagnoses cloud-only login failures.
        // Never retain typed credentials or a verification code in diagnostics.
        try {
          const page = await this.getPage();
          const screenshot = await page.screenshot({
            mask: [page.locator("input")],
            timeout: 5000,
          });
          let text = await page.locator("body").innerText({ timeout: 5000 });
          for (const value of [
            username,
            password,
            ...Object.values(this.headers),
          ]) {
            if (value) text = text.split(value).join("[redacted]");
          }
          text = text.replace(/\b\d{6}\b/g, "[redacted]");
          await writeState(`jobs/${env.EQ_JOB_ID}/login-diagnostic.json`, {
            version: 1,
            stage: this.diagnosticStage,
            text,
            screenshot: screenshot.toString("base64"),
          });
        } catch {
          logger.warn("EQ masked login diagnostic was unavailable");
        }
      }
      if (error instanceof EQMaintenance) {
        logger.info("EQ scheduled maintenance detected; retrieval deferred");
        throw error;
      }
      if (error instanceof z.ZodError)
        logger.error(
          `EQ response schema mismatch: ${error.issues.map((i) => i.path.join(".")).join(", ")}`,
        );
      else if (error instanceof Error && error.message.startsWith("EQ "))
        logger.error(error.message);
      else if (
        error instanceof Error &&
        ["account-discovery", "personal-history", "card-history"].includes(
          this.diagnosticStage,
        )
      ) {
        let message = error.message.split("\n", 1)[0];
        for (const value of [
          username,
          password,
          ...Object.values(this.headers),
        ].sort((a, b) => b.length - a.length)) {
          if (value) message = message.split(value).join("[redacted]");
        }
        logger.error(`EQ API diagnostic: ${message}`);
      }
      await this.handleError(error as Error);
      throw error;
    } finally {
      clearInterval(progress);
      await this.closeBrowser();
    }
  }

  private async checkMaintenance() {
    const page = await this.getPage();
    if (new URL(page.url()).hostname !== "secure.eqbank.ca") return;
    const text = await page
      .locator("body")
      .innerText({ timeout: 3000 })
      .catch(() => "");
    if (/scheduled maintenance/i.test(text) && /eqbankstatus\.ca/i.test(text)) {
      this.diagnosticStage = "bank-maintenance";
      throw new EQMaintenance();
    }
  }

  private armHeaders() {
    this.headers = {};
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }
  private async waitForHeaders(ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.ready!.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
    clearTimeout(timer);
    return result;
  }
  private async login(username: string, password: string) {
    const page = await this.getPage();
    this.diagnosticStage = "login-email";
    const emailInput = page.getByLabel("Email address", { exact: true });
    await emailInput.waitFor({ state: "visible", timeout: 30000 });
    await emailInput.fill(username);
    await page.getByRole("button", { name: /^Sign in$/i }).click();
    this.diagnosticStage = "login-password";
    const passwordInput = page.getByLabel("Password", { exact: true });
    await passwordInput.waitFor({ state: "visible", timeout: 30000 });
    await passwordInput.fill(password);
    logger.debug("EQ password field filled");
    const afterDate = new Date();
    await page.getByRole("button", { name: /^Sign in$/i }).click();
    this.diagnosticStage = "login-code-field";
    const codeInput = page.locator('input[autocomplete="one-time-code"]');
    try {
      await codeInput.waitFor({ state: "visible", timeout: 25_000 });
    } catch {
      const errorText = await page.locator("body").innerText();
      if (
        /wrong email|wrong password|invalid.*password|incorrect.*password|incorrect.*email/i.test(
          errorText,
        )
      )
        throw new EQCredentialsRejected();
      throw new Error("EQ email verification challenge was not reached");
    }
    const code = await getEmailTwoFactorAuthenticationCode({
      afterDate,
      sender: "alert@eqbank.ca",
      subject: "EQ Bank One Time Passcode - ",
      subjectPrefix: true,
      codeLength: 6,
    });
    this.diagnosticStage = "login-code-verify";
    await codeInput.fill(code);
    await page.getByRole("button", { name: "Verify", exact: true }).click();
  }

  private async restoreSession() {
    if (await this.restoreSavedSession()) return true;
    const value: any = await readState(sessionKey);
    if (
      !value ||
      value.version !== 1 ||
      Date.now() - Date.parse(value.savedAt) > 7 * 86400_000
    )
      return false;
    const context = this.getContext();
    await context.addCookies(value.state.cookies);
    await context.addInitScript(
      ({ origins, sessions }) => {
        const origin = (globalThis as any).location.origin as string;
        const storage = origins.find((item: any) => item.origin === origin);
        for (const item of storage?.localStorage ?? [])
          localStorage.setItem(item.name, item.value);
        for (const [key, value] of Object.entries(sessions[origin] ?? {}))
          sessionStorage.setItem(key, String(value));
      },
      { origins: value.state.origins, sessions: value.sessions },
    );
    return true;
  }
  private async saveSession() {
    const context = this.getContext();
    const sessions: Record<string, Record<string, string>> = {};
    for (const page of context.pages()) {
      if (new URL(page.url()).origin !== "https://secure.eqbank.ca") continue;
      sessions[new URL(page.url()).origin] = await page.evaluate(() =>
        Object.fromEntries(Object.entries(sessionStorage)),
      );
    }
    await writeState(sessionKey, {
      version: 1,
      savedAt: new Date().toISOString(),
      state: await context.storageState(),
      sessions,
    });
  }
  private async json(path: string, extraHeaders: Record<string, string> = {}) {
    this.diagnosticStage = path.startsWith("/accounts/v2")
      ? "account-discovery"
      : path.includes("card-history")
        ? "card-history"
        : "personal-history";
    const response = await this.getContext().request.get(`${API}${path}`, {
      headers: { ...this.headers, ...extraHeaders },
      timeout: 25_000,
      maxRedirects: 0,
    });
    if (!response.ok())
      throw new Error(`EQ history request failed (HTTP ${response.status()})`);
    return response.json();
  }
}
