import { formatISO, subDays } from "date-fns";
import type { Response } from "playwright-core";
import { BankFailure } from "../../sessions/types";
import { getEmailTwoFactorAuthenticationCode } from "../../utils/2fa";
import env from "../../utils/env";
import logger from "../../utils/logger";
import { Bank } from "../Bank";
import { BankName } from "../types";
import { AccountResponse, TransactionsResponse } from "./schemas";

export class RogersBank extends Bank {
  constructor() {
    super(BankName.RogersBank);
  }

  public static async create(username: string, password: string) {
    const rogersBank = new RogersBank();
    try {
      await rogersBank.launchBrowser();
      await rogersBank.restoreSavedSession();
      await rogersBank.login(username, password);
      await rogersBank.persistSession();
      await rogersBank.closeBrowser();
    } catch (error) {
      if (error instanceof Error) {
        await rogersBank.handleError(error);
      }
      throw error;
    }
    return rogersBank;
  }

  private async fetchTransactions(
    accountId: string,
    customerId: string,
    accountName: string,
    accountUuid: string,
    response: Response,
  ) {
    if (
      !response
        .url()
        .startsWith(
          `https://selfserve.apis.rogersbank.com/corebank/v1/account/${accountId}/customer/${customerId}/transactions`,
        )
    )
      throw new Error("Unexpected Rogers transaction account");

    const url = new URL(
      `https://selfserve.apis.rogersbank.com/corebank/v1/account/${accountId}/customer/${customerId}/transactions`,
    );
    url.searchParams.append(
      "fromDate",
      formatISO(subDays(this.date, 10), {
        representation: "date",
      }),
    );
    url.searchParams.append(
      "toDate",
      formatISO(this.date, {
        representation: "date",
      }),
    );

    const transactionsResponse = await fetch(url.toString(), {
      headers: await response.request().allHeaders(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!transactionsResponse.ok) {
      throw new Error(
        `Failed to fetch transactions: ${transactionsResponse.statusText}`,
      );
    }

    const transactions = await transactionsResponse.json();

    const postedTransactions = TransactionsResponse.parse(transactions);
    logger.info(
      `Fetched transactions for account ${accountName} (ID: ${accountUuid})`,
    );

    return postedTransactions;
  }

  private async login(username: string, password: string): Promise<void> {
    const page = await this.getPage();
    // Arm listeners before any action that can emit the response.
    const detailResponse = page.waitForResponse(
      (response) =>
        /^https:\/\/selfserve\.apis\.rogersbank\.com\/corebank\/v1\/account\/\d+\/customer\/\d+\/detail$/.test(
          response.url(),
        ) && response.request().method() === "GET",
      { timeout: 180_000 },
    );
    const activityResponse = page.waitForResponse(
      (response) =>
        /^https:\/\/selfserve\.apis\.rogersbank\.com\/corebank\/v1\/account\/\d+\/customer\/\d+\/transactions/.test(
          response.url(),
        ) && response.request().method() === "GET",
      { timeout: 180_000 },
    );
    void detailResponse.catch(() => {});
    void activityResponse.catch(() => {});

    await page.route(
      "https://selfserve.apis.rogersbank.com/**",
      async (route) => {
        const request = route.request();
        const postData = request.postData();

        const headers = await request.allHeaders();
        let headersModified = false;

        if (headers.channel === "101") {
          headers.channel = "201";
          headersModified = true;
        }

        let modifiedPostData = postData;
        let bodyModified = false;

        if (postData) {
          try {
            const data = JSON.parse(postData);

            if (data.channel === "101") {
              data.channel = "201";
              bodyModified = true;
            }

            if (data.recaptchaToken) {
              delete data.recaptchaToken;
              bodyModified = true;
            }

            if (bodyModified) {
              modifiedPostData = JSON.stringify(data);
            }
          } catch {}
        }

        if (headersModified || bodyModified) {
          await route.continue({ headers, postData: modifiedPostData });
        } else {
          await route.continue();
        }
      },
    );

    logger.debug("Navigating to Rogers Bank home page");
    await page.goto("https://selfserve.rogersbank.com/home");

    const isLoginRequired = await Promise.race([
      page.waitForSelector("button[aria-label='Sign in' i]").then(() => true),
      page.waitForSelector("button[aria-label='Sign out' i]").then(() => false),
    ]);

    if (isLoginRequired) {
      await page
        .getByRole("textbox", { name: "Username" })
        .pressSequentially(username);
      await page
        .getByRole("textbox", { name: "Password" })
        .pressSequentially(password);
      await page.getByRole("checkbox", { name: "Remember me" }).check();
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response
              .url()
              .startsWith(
                "https://selfserve.apis.rogersbank.com/v1/authenticate/user/",
              ) && response.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Sign in" }).click(),
      ]);
      const isTwoFactorAuthenticationRequired = response.status() === 412;
      if (!response.ok() && !isTwoFactorAuthenticationRequired) {
        const status = response.status();
        throw new BankFailure(
          [400, 401].includes(status)
            ? "credentials-rejected"
            : status === 403
              ? "challenge-required"
              : status === 429
                ? "throttled"
                : "transport-failed",
        );
      }

      if (isTwoFactorAuthenticationRequired) {
        this.diagnosticStage = "email-verification";
        logger.debug("Two-factor authentication required");
        logger.debug("Filling in two-factor authentication code");
        // Masked email labels still contain @; never fall back to SMS.
        const byEmailLabel = page.getByRole("radio", { name: /email|@/i });
        await byEmailLabel
          .first()
          .waitFor({ state: "visible" })
          .catch(() => {
            throw new BankFailure("challenge-required");
          });
        if ((await byEmailLabel.count()) !== 1)
          throw new Error("Expected one email verification option");
        await byEmailLabel.check();
        const requestedAt = new Date();
        await page.getByRole("button", { name: "Send code" }).click();
        const code = await getEmailTwoFactorAuthenticationCode({
          afterDate: requestedAt,
          sender: env.ROGERS_EMAIL_SENDER!,
          subject: env.ROGERS_EMAIL_SUBJECT!,
          codeLength: env.ROGERS_EMAIL_CODE_LENGTH!,
        });
        await page
          .getByRole("textbox", { name: "Verification Code" })
          .fill(code);
        await page.getByRole("button", { name: "Continue" }).click();
      }
    }

    if (!isLoginRequired) {
      await page.reload();
    }

    this.diagnosticStage = "account-discovery";
    logger.debug("Waiting for response");
    const response = await detailResponse;

    const json = await response.json();
    const account = AccountResponse.parse(json);

    const transactions = await this.fetchTransactions(
      account._accountId,
      account._customerId,
      account.name,
      account.id,
      await activityResponse,
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
}
