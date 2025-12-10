import { formatISO, parseISO, subDays } from "date-fns";
import { z } from "zod";
import { getSMSTwoFactorAuthenticationCode } from "../../utils/2fa.js";
import logger from "../../utils/logger.js";
import { Bank } from "../Bank.js";
import { BankName } from "../types.js";
import { Account, AccountResponse, TransactionsResponse } from "./schemas";

export class Tangerine extends Bank {
  constructor() {
    super(BankName.Tangerine);
  }

  public static async create(loginID: string, password: string) {
    const tangerine = new Tangerine();
    try {
      await tangerine.launchBrowser();
      await tangerine.login(loginID, password);
      await tangerine.closeBrowser();
    } catch (error) {
      if (error instanceof Error) {
        await tangerine.handleError(error);
      } else {
        throw error;
      }
    }
    return tangerine;
  }

  private async fetchAccounts() {
    const page = await this.getPage();

    logger.debug("Fetching accounts from Tangerine");
    const response = await page.waitForResponse(
      (response) =>
        response.url() ===
          "https://secure.tangerine.ca/web/rest/pfm/v1/accounts" &&
        response.request().method() === "GET",
    );
    const json = await response.json();
    const accounts = AccountResponse.parse(json);
    logger.debug(
      `Fetched ${accounts.length} accounts from Tangerine`,
      accounts,
    );

    return await Promise.all(
      accounts.map(async (account) => ({
        ...account,
        transactions: await this.fetchTransactions(account),
      })),
    );
  }

  private async fetchTransactions(account: z.infer<typeof Account>) {
    logger.debug(
      `Fetching transactions for account ${account.name} (ID: ${account.id})`,
    );
    const response = await fetch(
      "https://secure.tangerine.ca/web/rest/pfm/v1/transactions?" +
        new URLSearchParams({
          accountIdentifiers: account._number,
          hideAuthorizedStatus: "true",
          periodFrom: formatISO(subDays(this.date, 10), {
            representation: "date",
          }),
        }).toString(),
      {
        headers: {
          "Accept-Language": "en_CA",
          Cookie: await this.getCookiesAsString(),
        },
      },
    );
    const json = await response.json();
    const transactions = TransactionsResponse.parse(json).sort(
      (a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime(),
    );
    logger.debug(
      `Fetched ${transactions.length} transaction(s) for account ${account.name}`,
      transactions,
    );

    return transactions;
  }

  private async login(loginID: string, password: string) {
    const page = await this.getPage();

    logger.debug("Navigating to Tangerine login page");
    await page.goto(
      "https://www.tangerine.ca/app/#/login/login-id?locale=en_CA",
    );

    logger.debug("Accepting cookies");
    await page.waitForSelector("#onetrust-accept-btn-handler");
    await page.click("#onetrust-accept-btn-handler");

    logger.debug("Filling in login ID");
    await page.getByRole("textbox", { name: "Login ID" }).fill(loginID);
    await page.getByRole("button", { name: "Next" }).click();

    logger.debug("Filling in password");
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Log In" }).click();

    logger.debug("Two-factor authentication required");
    logger.debug("Filling in two-factor authentication code");
    const code = await getSMSTwoFactorAuthenticationCode({
      afterDate: this.date,
      sender: "864674",
    });
    await page.getByRole("textbox", { name: "Security Code" }).fill(code);
    await page.getByRole("checkbox", { name: "Skip on this device" }).check();
    await page.getByRole("button", { name: "Log In" }).click();

    const accounts = await this.fetchAccounts();
    this.setAccounts(accounts.map(({ _number, ...account }) => account));
  }
}
