import { format } from "date-fns";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BrowserContext, chromium, LaunchOptions, Page } from "playwright";
import { z } from "zod";
import env from "../utils/env";
import logger from "../utils/logger";
import { sendNotification } from "../utils/pushover";
import { uploadFile } from "../utils/s3";
import { Account, BankName, bankNames } from "./types";

export class Bank {
  private readonly bank: BankName;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  protected date = new Date();
  private accounts: z.infer<typeof Account>[] = [];

  constructor(bank: BankName) {
    this.bank = bank;
  }

  protected async launchBrowser() {
    logger.debug("Launching browser");
    const options: LaunchOptions = {
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    };
    if (env.PROXY_SERVER && env.PROXY_USERNAME && env.PROXY_PASSWORD) {
      options.proxy = {
        server: env.PROXY_SERVER,
        username: env.PROXY_USERNAME,
        password: env.PROXY_PASSWORD,
      };
    }
    const browser = await chromium.launch(options);
    logger.debug("Creating new context");
    this.context = await browser.newContext();
    await this.startTracing();
    logger.debug("Creating new page");
    this.page = await this.context.newPage();
  }

  protected async closeBrowser(tracingFilePath?: string) {
    await this.stopTracing(tracingFilePath);
    logger.debug("Closing browser");
    await this.page?.context().browser()?.close();
    this.page = null;
  }

  protected async startTracing() {
    logger.debug("Starting tracing");
    await this.context?.tracing.start({ screenshots: true, snapshots: true });
  }

  protected async stopTracing(filePath?: string) {
    logger.debug("Stopping tracing");
    await this.context?.tracing.stop({ path: filePath });
  }

  protected async handleError(error: unknown) {
    logger.error(error);
    const getTraceFilePath = (fileName: string) => `traces/${fileName}`;
    const getTraceFileName = () =>
      `${format(this.date, "yyyy-MM-dd")}-${this.bank}-${randomUUID()}.zip`;
    const traceFileName = getTraceFileName();
    const traceFilePath = getTraceFilePath(traceFileName);
    await this.closeBrowser(traceFilePath);
    logger.info(`Saved trace to ${traceFilePath}`);
    const traceFile = await readFile(traceFilePath);
    await uploadFile(traceFileName, "application/zip", traceFile);
    await sendNotification(
      `Error fetching accounts from ${bankNames[this.bank]}.`,
      {
        title: "Error Fetching Accounts",
        url: "https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups",
        url_title: "Open AWS Console",
      },
    );
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
