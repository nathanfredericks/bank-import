import { formatISO, subDays } from "date-fns";
import { z } from "zod";
import { getEmailTwoFactorAuthenticationCode } from "../../utils/2fa";
import axios from "../../utils/axios";
import logger from "../../utils/logger";
import { Bank } from "../Bank";
import { BankName } from "../types";
import {
  AccountResponse,
  TransactionsResponse,
  UserResponse,
  ValidateCodeResponse,
} from "./schemas";

export class RogersBank extends Bank {
  constructor() {
    super(BankName.RogersBank);
  }

  public static async create(username: string, password: string) {
    const rogersBank = new RogersBank();
    try {
      await rogersBank.launchBrowser(true);
      await rogersBank.login(username, password);
      await rogersBank.closeBrowser(undefined, true);
    } catch (error) {
      if (error instanceof Error) {
        await rogersBank.handleError(error);
      } else {
        throw error;
      }
    }
    return rogersBank;
  }

  private async login(username: string, password: string): Promise<void> {
    const page = await this.getPage();
    logger.debug("Navigating to Rogers Bank login page");
    await page.goto("https://selfserve.rogersbank.com/sign-in?locale=en");

    logger.debug("Filling in username and password");
    await page.getByRole("textbox", { name: "Username" }).fill(username);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
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

    let accountId: string;
    let customerId: string;

    if (isTwoFactorAuthenticationRequired) {
      logger.debug("Two-factor authentication required");
      const authResult = await this.handleTwoFactorAuthentication();
      accountId = authResult.accountId;
      customerId = authResult.customerId;
    } else {
      const json = await response.json();
      const userResult = UserResponse.parse(json);
      accountId = userResult.accountId;
      customerId = userResult.customerId;
    }

    await this.processAccount(accountId, customerId);
  }

  private async processAccount(
    accountId: string,
    customerId: string,
  ): Promise<void> {
    const page = await this.getPage();
    const response = await page.waitForResponse(
      (response: any) =>
        response.url() ===
          `https://selfserve.apis.rogersbank.com/corebank/v1/account/${accountId}/customer/${customerId}/detail` &&
        response.request().method() === "GET",
    );

    const json = await response.json();
    const account = AccountResponse.parse(json);
    const transactions = await this.fetchTransactions(
      accountId,
      customerId,
      account.name,
    );

    this.setAccounts([
      {
        ...account,
        transactions,
      },
    ]);
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
          .includes(
            `/account/${accountId}/customer/${customerId}/transactions`,
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

  private async handleTwoFactorAuthentication(): Promise<
    z.infer<typeof ValidateCodeResponse>
  > {
    const page = await this.getPage();
    logger.debug("Filling in two-factor authentication code");
    await page.getByRole("radio", { name: "@" }).click();
    await page.getByRole("button", { name: "Send code" }).click();
    const code = await getEmailTwoFactorAuthenticationCode({
      afterDate: this.date,
      sender: "onlineservices@RogersBank.com",
      subject: "Your verification code",
      regex: /\b\d{8}\b/,
    });
    await page.getByRole("textbox", { name: "Verification Code" }).fill(code);
    await page.getByRole("button", { name: "Continue" }).click();
    const response = await page.waitForResponse(
      (response: any) =>
        response
          .url()
          .startsWith(
            "https://selfserve.apis.rogersbank.com/v1/authenticate",
          ) && response.request().method() === "POST",
    );
    const json = await response.json();
    const result = ValidateCodeResponse.parse(json);
    return result;
  }
}
