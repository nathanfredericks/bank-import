import { launchContext } from "cloakbrowser";
import { format } from "date-fns";
import { randomUUID } from "node:crypto";
import { BrowserContext, Page } from "playwright-core";
import { z } from "zod";
import env from "../utils/env";
import logger from "../utils/logger";
import { uploadFile } from "../utils/s3";
import { Account, BankName } from "./types";

export class Bank {
  private readonly bank: BankName;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  protected date = new Date();
  protected diagnosticStage = "browser-start";
  private accounts: z.infer<typeof Account>[] = [];

  constructor(bank: BankName) {
    this.bank = bank;
  }

  protected async launchBrowser() {
    logger.debug("Launching browser");
    this.context = await launchContext({
      headless: false,
      humanize: true,
      humanPreset: "careful",
      geoip: true,
      timezone: "America/Halifax",
    });
    logger.debug("Creating new page");
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30_000);
    this.page.setDefaultNavigationTimeout(30_000);
    this.diagnosticStage = "login";
  }

  protected async closeBrowser() {
    logger.debug("Closing browser");
    await this.context?.close();
    this.context = null;
    this.page = null;
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
    if (Bun.env.LOCAL_SECRETS_STDIN === "true") {
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

  public getAccounts() {
    return this.accounts;
  }

  protected setAccounts(accounts: z.infer<typeof Account>[]) {
    this.accounts = accounts;
  }
}
