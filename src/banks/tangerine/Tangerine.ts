import { formatISO, parseISO, subDays } from "date-fns";
import { z } from "zod";
import { getSMSTwoFactorAuthenticationCode } from "../../utils/2fa.js";
import logger from "../../utils/logger.js";
import secrets from "../../utils/secrets.js";
import { Bank } from "../Bank.js";
import { BankName } from "../types.js";
import {
  Account,
  AccountResponse,
  DisplayChallengeQuestionResponse,
  TransactionsResponse,
} from "./schemas.js";

export class Tangerine extends Bank {
  constructor() {
    super(BankName.Tangerine);
  }

  public static async create(loginID: string, pin: string) {
    const tangerine = new Tangerine();
    try {
      await tangerine.launchBrowser(true);
      await tangerine.login(loginID, pin);
      await tangerine.closeBrowser();
    } catch (error) {
      await tangerine.handleError(error);
    }
    return tangerine;
  }

  private async fetchAccounts() {
    logger.debug("Fetching accounts from Tangerine");
    const response = await fetch(
      "https://secure.tangerine.ca/web/rest/pfm/v1/accounts",
      {
        headers: {
          Cookie: await this.getCookiesAsString(),
        },
      },
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
    logger.debug(`Fetching transactions for account ${account.name}`);
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

  private async login(loginID: string, pin: string) {
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

    logger.debug("Waiting for response");
    const response = await page.waitForResponse(
      (response) =>
        (response.url().endsWith("displayPIN") ||
          response.url().endsWith("displayChallengeQuestion")) &&
        response.request().method() === "GET",
    );

    if (response.url().endsWith("displayChallengeQuestion")) {
      logger.debug("Security question required");
      logger.debug("Filling in security question");
      const json = await response.json();
      const securityQuestion = DisplayChallengeQuestionResponse.parse(json);
      const securityAnswer =
        secrets.TANGERINE_SECURITY_QUESTIONS[securityQuestion];
      if (!securityAnswer) {
        throw new Error(`Security question not found: ${securityQuestion}`);
      }
      await page.getByRole("textbox", { name: "Answer" }).fill(securityAnswer);
      await page.getByRole("button", { name: "Next", exact: true }).click();
    }

    logger.debug("Filling in PIN");
    await page.getByRole("textbox", { name: "PIN" }).fill(pin);
    await page.getByRole("button", { name: "Log In" }).click();

    await page.waitForURL(
      (url) =>
        url.toString() ===
          "https://www.tangerine.ca/app/#/accounts?locale=en_CA" ||
        url.toString() ===
          "https://www.tangerine.ca/app/#/login/two-factor-authentication?locale=en_CA",
    );

    if (
      page.url() ===
      "https://www.tangerine.ca/app/#/login/two-factor-authentication?locale=en_CA"
    ) {
      logger.debug("Two-factor authentication required");
      logger.debug("Filling in two-factor authentication code");
      const code = await getSMSTwoFactorAuthenticationCode(this.date, "864732");
      await page.getByRole("textbox", { name: "Security Code" }).fill(code);
      await page.getByRole("button", { name: "Log In" }).click();
    }

    const accounts = await this.fetchAccounts();
    this.setAccounts(accounts.map(({ _number, ...account }) => account));
  }
}
