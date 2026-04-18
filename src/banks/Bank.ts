import { format } from "date-fns";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  private userDataDir: string | null = null;

  constructor(bank: BankName) {
    this.bank = bank;
  }

  protected async launchBrowser() {
    this.userDataDir = await mkdtemp(join(tmpdir(), `user-data-`));
    logger.debug(`Created temporary user data directory: ${this.userDataDir}`);

    logger.debug("Launching browser");
    const options: LaunchOptions = {
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    };
    if (env.HTTP_PROXY) {
      options.proxy = {
        server: env.HTTP_PROXY,
      };
    }
    this.context = await chromium.launchPersistentContext(
      this.userDataDir,
      options,
    );
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

  protected async handleError(error: Error) {
    logger.error(error);
    const errorMessage = error.stack?.split("\n")[0];
    const getTraceFilePath = (fileName: string) => `traces/${fileName}`;
    const getTraceFileName = () =>
      `${format(this.date, "yyyy-MM-dd")}-${this.bank}-${randomUUID()}.zip`;
    const traceFileName = getTraceFileName();
    const traceFilePath = getTraceFilePath(traceFileName);
    await this.closeBrowser(traceFilePath);
    logger.info(`Saved trace to ${traceFilePath}`);
    const traceFile = await readFile(traceFilePath);
    await uploadFile(
      env.AWS_S3_TRACES_BUCKET_NAME,
      traceFileName,
      "application/zip",
      traceFile,
    );
    await sendNotification(errorMessage || null, {
      title: `Error Logging Into ${bankNames[this.bank]}`,
      url: "https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups",
      url_title: "Open AWS Console",
      priority: -1,
    });
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
