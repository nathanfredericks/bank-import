import { parseISO, subDays } from "date-fns";
import { z } from "zod";
import { getEmailTwoFactorAuthenticationCode } from "../../utils/2fa";
import axios from "../../utils/axios";
import logger from "../../utils/logger";
import { Bank } from "../Bank";
import { BankName } from "../types";
import { Account, ActivityResponse, UserResponse } from "./schemas";

export class RogersBank extends Bank {
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
      await rogersBank.handleError(error);
    }
    return rogersBank;
  }

  private async fetchTransactions(account: z.infer<typeof Account>) {
    logger.debug(`Fetching transactions for account ${account.name}`);
    const [currentTransactionsResponse, previousTransactionsResponse] =
      await Promise.all([
        axios.get(
          `https://rbaccess.rogersbank.com/issuing/digital/account/${account._number}/customer/${account._customerId}/activity`,
          {
            headers: {
              Cookie: await this.getCookiesAsString(),
            },
          },
        ),
        axios.get(
          `https://rbaccess.rogersbank.com/issuing/digital/account/${account._number}/customer/${account._customerId}/activity?cycleStartDate=${account._previousStatementDate}`,
          {
            headers: {
              Cookie: await this.getCookiesAsString(),
            },
          },
        ),
      ]);
    const currentTransactions = ActivityResponse.parse(
      currentTransactionsResponse.data,
    );
    const previousTransactions = ActivityResponse.parse(
      previousTransactionsResponse.data,
    );
    let transactions = [...currentTransactions, ...previousTransactions];
    transactions = transactions
      .filter((transaction) => {
        const date = parseISO(transaction.date);
        return date >= subDays(this.date, 10) && date <= this.date;
      })
      .sort((a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime());
    logger.debug(
      `Fetched ${transactions.length} transaction(s) for account ${account.name}`,
      transactions,
    );

    return transactions;
  }

  private async processAccounts(accounts: z.infer<typeof Account>[] | null) {
    if (!accounts) return;

    const accountsWithTransactions = await Promise.all(
      accounts.map(async (account) => ({
        ...account,
        transactions: await this.fetchTransactions(account),
      })),
    );

    this.setAccounts(
      accountsWithTransactions.map(
        ({ _number, _customerId, _previousStatementDate, ...account }) =>
          account,
      ),
    );
  }

  async login(username: string, password: string): Promise<void> {
    const page = await this.getPage();
    logger.debug("Navigating to Rogers Bank login page");
    await page.goto(
      "https://rbaccess.rogersbank.com/?product=ROGERSBRAND&locale=en_CA",
    );

    logger.debug("Filling in username and password");
    await page.getByRole("textbox", { name: "Username" }).fill(username);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();

    logger.debug("Waiting for response");
    const response = await page.waitForResponse(
      (response) =>
        response.url() ===
          "https://rbaccess.rogersbank.com/issuing/digital/authenticate/user" &&
        response.request().method() === "POST",
    );

    const isTwoFactorAuthenticationRequired = response.status() === 401;

    if (isTwoFactorAuthenticationRequired) {
      logger.debug("Two-factor authentication required");
      logger.debug("Filling in two-factor authentication code");
      await page.getByRole("radio", { name: "@" }).click();
      await page.getByRole("button", { name: "Send code" }).click();
      const code = await getEmailTwoFactorAuthenticationCode(
        this.date,
        "onlineservices@RogersBank.com",
        "Your verification code",
      );
      await page.getByRole("button", { name: "OK" }).click();
      await page.getByRole("textbox", { name: "One-time passcode" }).fill(code);
      await page.getByRole("button", { name: "Continue" }).click();

      logger.debug("Waiting for response");
      const response = await page.waitForResponse(
        (response) =>
          response.url() ===
            "https://rbaccess.rogersbank.com/issuing/digital/authenticate/validatepasscode" &&
          response.request().method() === "POST",
      );
      const json = await response.json();
      const accounts = UserResponse.parse(json);

      await this.processAccounts(accounts);
    } else {
      const json = await response.json();
      const accounts = UserResponse.parse(json);

      await this.processAccounts(accounts);
    }
  }
}
