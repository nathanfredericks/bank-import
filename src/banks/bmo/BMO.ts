import { tz } from "@date-fns/tz";
import { format, formatISO, parseISO, subDays } from "date-fns";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getEmailTwoFactorAuthenticationCode } from "../../utils/2fa";
import axios from "../../utils/axios";
import logger from "../../utils/logger";
import { Bank } from "../Bank";
import { BankName } from "../types";
import {
  Account,
  AuthenticateResponse,
  BankAccountTransactionsResponse,
  CreditCardTransactionsResponse,
  VerifyCredentialResponse,
  VerifyTwoFactorAuthenticationCodeResponse,
} from "./schemas";

export class BMO extends Bank {
  constructor() {
    super(BankName.BMO);
  }

  public static async create(cardNumber: string, password: string) {
    const bmo = new BMO();
    try {
      await bmo.launchBrowser();
      await bmo.login(cardNumber, password);
      await bmo.closeBrowser();
    } catch (error) {
      if (error instanceof Error) {
        await bmo.handleError(error);
      } else {
        throw error;
      }
    }
    return bmo;
  }

  private async generateRequestHeaders() {
    const page = await this.getPage();
    const date = new Date();

    const generateHTTPRequestID = () => {
      const uuid = randomUUID();
      return `REQ_${uuid.replace(/\W/g, "").toLowerCase().slice(0, 20)}`;
    };

    return {
      ver: "1.0",
      channelType: "OLB",
      appName: "OLB",
      hostName: "BDBN-HostName",
      clientDate: format(date, "yyyy-MM-dd'T'HH:mm:ss.SSS", {
        in: tz("UTC"),
      }),
      rqUID: generateHTTPRequestID(),
      clientSessionID: "session-id",
      userAgent: await page.evaluate(() => navigator.userAgent),
      clientIP: "127.0.0.1",
      mfaDeviceToken: await this.getCookie("PMData"),
    };
  }

  private async fetchTransactions(account: z.infer<typeof Account>) {
    if (account._type === "BANK_ACCOUNT") {
      logger.debug(`Fetching transactions for account ${account.name}`);
      const { data } = await axios.post(
        "https://www1.bmo.com/banking/services/accountdetails/getBankAccountDetails",
        {
          MySummaryRq: {
            HdrRq: await this.generateRequestHeaders(),
            BodyRq: {
              accountIndex: account._index,
              limitNoTxns: "1500",
              filterFromDate: formatISO(subDays(this.date, 10), {
                representation: "date",
              }),
              filterToDate: formatISO(this.date, { representation: "date" }),
            },
          },
        },
        {
          headers: {
            "X-XSRF-TOKEN": await this.getCookie("XSRF-TOKEN"),
            Cookie: await this.getCookiesAsString(),
          },
        },
      );
      let transactions = BankAccountTransactionsResponse.parse(data);
      transactions = transactions
        .filter(
          (transaction) => parseISO(transaction.date) >= subDays(this.date, 10),
        )
        .sort(
          (a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime(),
        );
      logger.info(
        `Fetched ${transactions.length} transaction(s) for account ${account.name}`,
        transactions,
      );
      return transactions;
    } else if (account._type === "CREDIT_CARD") {
      logger.debug(`Fetching transactions for account ${account.name}`);
      const { data: unbilledTransactionsData } = await axios.post(
        "https://www1.bmo.com/banking/services/accountdetails/getCCAccountDetails",
        {
          MySummaryRq: {
            HdrRq: await this.generateRequestHeaders(),
            BodyRq: {
              accountIndex: account._index,
              limitNoTxns: "1500",
              filter: "unbilled",
            },
          },
        },
        {
          headers: {
            "X-XSRF-TOKEN": await this.getCookie("XSRF-TOKEN"),
            Cookie: await this.getCookiesAsString(),
          },
        },
      );

      const {
        transactions: unbilledTransactions,
        statementDates: previousStatementDates,
      } = CreditCardTransactionsResponse.parse(unbilledTransactionsData);

      let allTransactions = [...unbilledTransactions];

      const previousStatementDate = previousStatementDates.sort().reverse()[0];

      if (previousStatementDate) {
        const { data: previousTransactionsData } = await axios.post(
          "https://www1.bmo.com/banking/services/accountdetails/getCCAccountDetails",
          {
            MySummaryRq: {
              HdrRq: await this.generateRequestHeaders(),
              BodyRq: {
                accountIndex: account._index,
                limitNoTxns: "1500",
                filter: previousStatementDate,
              },
            },
          },
          {
            headers: {
              "X-XSRF-TOKEN": await this.getCookie("XSRF-TOKEN"),
              Cookie: await this.getCookiesAsString(),
            },
          },
        );
        const { transactions: previousTransactions } =
          CreditCardTransactionsResponse.parse(previousTransactionsData);
        allTransactions = [...allTransactions, ...previousTransactions];
      }

      const transactions = allTransactions
        .filter(
          (transaction) => parseISO(transaction.date) >= subDays(this.date, 10),
        )
        .sort(
          (a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime(),
        );
      logger.info(
        `Fetched ${transactions.length} transaction(s) for account ${account.name}`,
        transactions,
      );
      return transactions;
    }
    return [];
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
      accountsWithTransactions.map(({ _index, _type, ...account }) => account),
    );
  }

  private async login(cardNumber: string, password: string) {
    const page = await this.getPage();
    logger.debug("Navigating to BMO login page");
    await page.goto("https://www1.bmo.com/banking/digital/login");

    logger.debug("Filling in card number and password");
    await page
      .getByRole("textbox", { name: "Card number" })
      .pressSequentially(cardNumber);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    logger.debug("Waiting for response");
    const verifyCredentialResponse = await page.waitForResponse(
      (response) =>
        response.url() ===
          "https://www1.bmo.com/banking/services/signin/verifyCredential" &&
        response.request().method() === "POST",
    );
    const json = await verifyCredentialResponse.json();
    const { accounts, isTwoFactorAuthenticationRequired } =
      VerifyCredentialResponse.parse(json);

    if (isTwoFactorAuthenticationRequired) {
      logger.debug("Two-factor authentication required");
      logger.debug("Filling in two-factor authentication code");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("radio", { name: "Email" }).click();
      await page
        .getByRole("checkbox", {
          name: "IMPORTANT: To proceed, you must confirm you will not provide this verification code to anyone.",
        })
        .click();
      await page.getByRole("button", { name: "Send code" }).click();
      const code = await getEmailTwoFactorAuthenticationCode(
        this.date,
        "bmoalerts@bmo.com",
        "BMO Verification Code",
      );
      await page.getByRole("textbox", { name: "Verification code" }).fill(code);
      await page.getByRole("button", { name: "Confirm" }).click();

      logger.debug("Waiting for response");
      const verifyResponse = await page.waitForResponse(
        (response) =>
          response.url().startsWith("https://www1.bmo.com/aac/sps/authsvc") &&
          response.url().endsWith("&operation=verify") &&
          response.request().method() === "POST",
      );
      const verifyJson = await verifyResponse.json();
      const isTrustedDevice =
        VerifyTwoFactorAuthenticationCodeResponse.parse(verifyJson);

      if (!isTrustedDevice) {
        await page.getByRole("button", { name: "Continue" }).click();
      }

      logger.debug("Waiting for response");
      const authenticateResponse = await page.waitForResponse(
        (response) =>
          response.url() ===
            "https://www1.bmo.com/banking/services/signin/authenticate" &&
          response.request().method() === "POST",
      );
      const authenticateJson = await authenticateResponse.json();
      const accounts = AuthenticateResponse.parse(authenticateJson);

      await this.processAccounts(accounts);
    } else {
      await this.processAccounts(accounts);
    }
  }
}
