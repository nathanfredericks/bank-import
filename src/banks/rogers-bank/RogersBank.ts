import { formatISO, subDays } from "date-fns";
import { getEmailTwoFactorAuthenticationCode } from "../../utils/2fa";
import axios from "../../utils/axios";
import logger from "../../utils/logger";
import { Bank } from "../Bank";
import { BankName } from "../types";
import { AccountResponse, TransactionsResponse } from "./schemas";

export class RogersBank extends Bank {
  private captchaLowScore = false;

  constructor() {
    super(BankName.RogersBank);
  }

  public static async create(username: string, password: string) {
    const rogersBank = new RogersBank();
    try {
      await rogersBank.launchBrowser();
      await rogersBank.login(username, password);
      await rogersBank.closeBrowser();
    } catch (error) {
      if (error instanceof Error) {
        await rogersBank.handleError(error);
      } else {
        throw error;
      }
    }
    return rogersBank;
  }

  private async fetchTransactions(
    accountId: string,
    customerId: string,
    accountName: string,
  ) {
    const page = await this.getPage();
    const response = await page.waitForResponse(
      (response: any) =>
        response
          .url()
          .startsWith(
            `https://selfserve.apis.rogersbank.com/corebank/v1/account/${accountId}/customer/${customerId}/transactions`,
          ) && response.request().method() === "GET",
    );

    const { data: transactions } = await axios.get(
      `https://selfserve.apis.rogersbank.com/corebank/v1/account/${accountId}/customer/${customerId}/transactions`,
      {
        headers: await response.request().allHeaders(),
        params: {
          fromDate: formatISO(subDays(this.date, 10), {
            representation: "date",
          }),
          toDate: formatISO(this.date, {
            representation: "date",
          }),
        },
      },
    );

    const postedTransactions = TransactionsResponse.parse(transactions);
    logger.info(
      `Fetched ${postedTransactions.length} transaction(s) for account ${accountName}`,
    );

    return postedTransactions;
  }

  private async login(username: string, password: string): Promise<void> {
    const page = await this.getPage();
    logger.debug("Navigating to Rogers Bank home page");
    await page.goto("https://selfserve.rogersbank.com/home");

    const isLoginRequired = await Promise.race([
      page.waitForSelector("button[aria-label='Sign in' i]").then(() => true),
      page.waitForSelector("button[aria-label='Sign out' i]").then(() => false),
    ]);

    if (isLoginRequired) {
      logger.debug("Filling in username and password");
      await page.getByRole("textbox", { name: "Username" }).fill(username);
      await page.getByRole("textbox", { name: "Password" }).fill(password);
      await page.getByRole("checkbox", { name: "Remember me" }).check();
      await page.getByRole("button", { name: "Sign in" }).click();

      logger.debug("Waiting for response");
      const response = await page.waitForResponse(
        (response) =>
          response
            .url()
            .startsWith(
              "https://selfserve.apis.rogersbank.com/v1/authenticate",
            ) && response.request().method() === "POST",
      );

      const isTwoFactorAuthenticationRequired = response.status() === 412;

      if (response.status() === 401) {
        try {
          const json = await response.json();
          if (json.errorCode === "ERR_401_RECAPTCHA_LOW_SCORE") {
            logger.debug(
              "ReCAPTCHA low score detected, deleting user data and failing silently",
            );
            this.captchaLowScore = true;
            await this.deleteUserData();
            return;
          }
        } catch (error) {}
      }

      if (isTwoFactorAuthenticationRequired) {
        logger.debug("Two-factor authentication required");
        logger.debug("Filling in two-factor authentication code");
        await page.getByRole("radio", { name: "@" }).click();
        await page.getByRole("button", { name: "Send code" }).click();
        const code = await getEmailTwoFactorAuthenticationCode({
          afterDate: this.date,
          sender: "onlineservices@RogersBank.com",
          subject: "Your verification code",
          regex: /\b\d{8}\b/,
        });
        await page
          .getByRole("textbox", { name: "Verification Code" })
          .fill(code);
        await page.getByRole("button", { name: "Continue" }).click();
      }
    }

    logger.debug("Waiting for response");
    const response = await page.waitForResponse(
      (response) =>
        /^https:\/\/selfserve\.apis\.rogersbank\.com\/corebank\/v1\/account\/\d+\/customer\/\d+\/detail$/.test(
          response.url(),
        ) && response.request().method() === "GET",
    );

    const json = await response.json();
    const account = AccountResponse.parse(json);

    const transactions = await this.fetchTransactions(
      account._accountId,
      account._customerId,
      account.name,
    );

    this.setAccounts([
      {
        id: account.id,
        name: account.name,
        balance: account.balance,
        transactions,
      },
    ]);
  }

  public isCaptchaLowScore(): boolean {
    return this.captchaLowScore;
  }
}
