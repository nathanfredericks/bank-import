import { launchContext } from "cloakbrowser";
import { format } from "date-fns";
import { randomUUID } from "node:crypto";
import { BrowserContext, Page, chromium } from "playwright-core";
import { z } from "zod";
import { SessionCapture } from "../sessions/capture";
import { SessionStore } from "../sessions/store";
import env from "../utils/env";
import logger from "../utils/logger";
import { uploadFile } from "../utils/s3";
import { Account, BankName } from "./types";

export class Bank {
  private readonly bank: BankName;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sessionCapture: SessionCapture | null = null;
  protected date = new Date();
  protected diagnosticStage = "browser-start";
  private accounts: z.infer<typeof Account>[] = [];

  constructor(bank: BankName) {
    this.bank = bank;
  }

  protected async launchBrowser(options: { standardChromium?: boolean } = {}) {
    logger.debug("Launching browser");
    if (options.standardChromium) {
      // Keep EQ's Linux browser reproducible with the official Chromium
      // bundled with the pinned Playwright image.
      const browser = await chromium.launch({ headless: false });
      this.context = await browser.newContext({
        timezoneId: "America/Halifax",
      });
      logger.info("EQ using bundled Playwright Chromium");
    } else {
      this.context = await launchContext({
        headless: false,
        humanize: true,
        humanPreset: "careful",
        geoip: true,
        timezone: "America/Halifax",
      });
    }
    if (process.env.SESSION_TABLE)
      this.sessionCapture = new SessionCapture(this.bank, this.context);
    logger.debug("Creating new page");
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30_000);
    this.page.setDefaultNavigationTimeout(30_000);
    this.diagnosticStage = "login";
  }

  protected async closeBrowser() {
    logger.debug("Closing browser");
    const context = this.context;
    this.context = null;
    this.page = null;
    // EQ redirects can leave context.close waiting on a page. Closing its
    // owned browser directly also closes the context and terminates Chromium.
    if (this.bank === BankName.EQBank && context?.browser()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          context.browser()!.close(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("EQ browser shutdown timed out")),
              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } else await context?.close();
  }

  protected async handleError(_error: Error) {
    logger.error(`Bank operation failed during ${this.diagnosticStage}`);
    const traceFileName = `${format(this.date, "yyyy-MM-dd")}-${this.bank}-${randomUUID()}.json`;
    // Playwright network traces record login POST bodies, cookies, and OTPs.
    // Store an allowlisted diagnostic record instead of raw browser traces.
    const diagnostic = JSON.stringify({
      bank: this.bank,
      stage: this.diagnosticStage,
      startedAt: this.date.toISOString(),
      failedAt: new Date().toISOString(),
      category: "bank-operation-failed",
    });
    if (process.env.LOCAL_SECRETS_STDIN === "true") {
      await this.closeBrowser().catch(() => {});
      return;
    }
    try {
      await uploadFile(
        env.AWS_S3_TRACES_BUCKET_NAME,
        traceFileName,
        "application/json",
        diagnostic,
      );
      logger.info(`Private trace saved: ${traceFileName}`);
    } catch {
      logger.error("Diagnostic trace could not be saved");
    } finally {
      await this.closeBrowser().catch(() => {});
    }
  }

  protected async getCookies() {
    if (!this.page) {
      throw new Error("Page is not initialized");
    }
    return this.page.context().cookies();
  }

  protected async persistSession() {
    await this.sessionCapture?.save();
  }

  protected async restoreSavedSession() {
    if (!process.env.SESSION_TABLE) return false;
    const saved = await new SessionStore().session();
    if (!saved) return false;
    const context = this.getContext();
    if (process.env.BANK_FORCE_LOGIN === "true") {
      if (this.bank === BankName.RogersBank) {
        const device =
          saved.state.origins
            .find(
              (origin) => origin.origin === "https://selfserve.rogersbank.com",
            )
            ?.localStorage.filter((entry) =>
              ["deviceId", "rememberedUsername"].includes(entry.name),
            ) ?? [];
        await context.addInitScript((entries) => {
          if (
            (globalThis as any).location.origin ===
            "https://selfserve.rogersbank.com"
          )
            for (const entry of entries)
              localStorage.setItem(entry.name, entry.value);
        }, device);
      }
      return false;
    }
    await context.addCookies(saved.state.cookies);
    await context.addInitScript(
      ({ origins, sessions }) => {
        const origin = (globalThis as any).location.origin;
        for (const item of origins.find((x) => x.origin === origin)
          ?.localStorage ?? [])
          localStorage.setItem(item.name, item.value);
        for (const [key, value] of Object.entries(sessions[origin] ?? {}))
          sessionStorage.setItem(key, value);
      },
      { origins: saved.state.origins, sessions: saved.sessions },
    );
    return true;
  }

  protected async getCookiesAsString() {
    const cookies = await this.getCookies();
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  protected async getCookie(name: string) {
    const cookies = await this.getCookies();
    const cookie = cookies.find((cookie) => cookie.name === name)?.value;
    if (!cookie) {
      throw new Error(`Cookie "${name}" not found`);
    }
    return cookie;
  }

  protected async getPage() {
    if (!this.page) {
      throw new Error("Page is not initialized");
    }
    return this.page;
  }

  protected getContext() {
    if (!this.context) throw new Error("Browser context is not initialized");
    return this.context;
  }

  public getAccounts() {
    return this.accounts;
  }

  protected setAccounts(accounts: z.infer<typeof Account>[]) {
    this.accounts = accounts;
  }
}
