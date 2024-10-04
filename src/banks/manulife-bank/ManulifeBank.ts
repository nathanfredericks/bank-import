import { tz } from "@date-fns/tz";
import { formatISO, parseISO, subDays } from "date-fns";
import { z } from "zod";
import { getSMSTwoFactorAuthenticationCode } from "../../utils/2fa.js";
import logger from "../../utils/logger.js";
import { Bank } from "../Bank.js";
import { BankName } from "../types.js";
import { Account, AccountResponse, TransactionsResponse } from "./schemas.js";

export class ManulifeBank extends Bank {
  constructor() {
    super(BankName.ManulifeBank);
  }

  public static async create(username: string, password: string) {
    const manulifeBank = new ManulifeBank();
    try {
      await manulifeBank.launchBrowser();
      await manulifeBank.login(username, password);
      await manulifeBank.closeBrowser();
    } catch (error) {
      await manulifeBank.handleError(error);
    }
    return manulifeBank;
  }

  private async fetchAccounts() {
    const page = await this.getPage();

    logger.debug("Fetching accounts from Manulife Bank");
    const response = await page.waitForResponse(
      (response) =>
        response.url() ===
          "https://online.manulifebank.ca/api/v9/bank/ca/v2/accounts/" &&
        response.request().method() === "GET",
    );
    const json = await response.json();
    const accounts = AccountResponse.parse(json);
    logger.debug(
      `Fetched ${accounts.length} account(s) from Manulife Bank`,
      accounts,
    );

    return await Promise.all(
      accounts.map(async (account) => {
        return {
          ...account,
          transactions: await this.fetchTransactions(
            account,
            response.request().headers(),
          ),
        };
      }),
    );
  }

  private async fetchTransactions(
    account: z.infer<typeof Account>,
    headers: { [key: string]: string },
  ) {
    const page = await this.getPage();

    logger.debug(`Fetching transactions for account ${account.name}`);
    const startDate = formatISO(subDays(this.date, 10), {
      representation: "date",
    });
    const endDate = formatISO(this.date, {
      representation: "date",
      in: tz("America/Toronto"),
    });
    const json = await page.evaluate(
      async ({ account, headers, startDate, endDate }) => {
        const response = await fetch(
          `https://online.manulifebank.ca/api/v9/bank/ca/v2/accounts/history/${account._index}/start/${startDate}/end/${endDate}`,
          {
            headers: {
              ...headers,
            },
          },
        );
        return await response.json();
      },
      { account, headers, startDate, endDate },
    );
    const transactions = TransactionsResponse.parse(json).sort(
      (a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime(),
    );
    logger.debug(
      `Fetched ${transactions.length} transaction(s) for account ${account.name}`,
      transactions,
    );

    return transactions;
  }

  async login(username: string, password: string): Promise<void> {
    const page = await this.getPage();

    logger.debug("Navigating to Manulife Bank login page");
    await page.goto("https://online.manulifebank.ca/accounts");

    await page.getByRole("button", { name: "Sign in" }).click();

    logger.debug("Filling in username and password");
    await page.getByRole("textbox", { name: "Username" }).click();
    await page
      .getByRole("textbox", { name: "Username" })
      .pressSequentially(username);
    await page.getByRole("textbox", { name: "Password" }).click();
    await page
      .getByRole("textbox", { name: "Password" })
      .pressSequentially(password);
    await page.getByRole("button", { name: "Sign In" }).click();

    logger.debug("Waiting for response");
    await page.waitForURL(
      (url) =>
        url.toString().startsWith("https://id.manulife.ca/otp-on-demand") ||
        url.toString().startsWith("https://id.manulife.ca/mfa") ||
        url.toString() === "https://online.manulifebank.ca/init",
    );

    const isTwoFactorAuthenticationRequired =
      page.url() !== "https://online.manulifebank.ca/init";

    if (isTwoFactorAuthenticationRequired) {
      logger.debug("Two-factor authentication required");
      logger.debug("Filling in two-factor authentication code");
      await page.getByRole("button", { name: "Text" }).click();
      const code = await getSMSTwoFactorAuthenticationCode(this.date, "626854");
      await page.getByRole("textbox", { name: "Code" }).pressSequentially(code);
      await page.getByRole("button", { name: "Continue" }).click();

      const accounts = await this.fetchAccounts();
      this.setAccounts(accounts.map(({ _index, ...account }) => account));
    } else {
      const accounts = await this.fetchAccounts();
      this.setAccounts(accounts.map(({ _index, ...account }) => account));
    }
  }
}
