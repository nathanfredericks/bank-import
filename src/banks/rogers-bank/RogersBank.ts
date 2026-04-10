import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { formatISO, subDays } from "date-fns";
import { getSMSTwoFactorAuthenticationCode } from "../../utils/2fa";
import env from "../../utils/env";
import logger from "../../utils/logger";
import { Bank } from "../Bank";
import { BankName } from "../types";
import {
  AccountResponse,
  PendingTransactionsResponse,
  TransactionsResponse,
} from "./schemas";

const PENDING_TRANSACTIONS_TABLE_NAME =
  env.AWS_DYNAMODB_PENDING_TRANSACTIONS_TABLE_NAME;
const ROGERS_BANK_WEBHOOK_NAME = "rogers-bank-webhook";
const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;
const MAX_BATCH_GET_KEYS = 100;
const MAX_BATCH_WRITE_ITEMS = 25;
const CARD_LAST4_LENGTH = 4;

const config: DynamoDBClientConfig = {};

if (
  env.AWS_ACCESS_KEY_ID &&
  env.AWS_SECRET_ACCESS_KEY &&
  env.AWS_DEFAULT_REGION
) {
  config.credentials = {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
  config.region = env.AWS_DEFAULT_REGION;
}

const client = new DynamoDBClient(config);
const docClient = DynamoDBDocumentClient.from(client);

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
      if (error instanceof Error) {
        await rogersBank.handleError(error);
      } else {
        throw error;
      }
    }
    return rogersBank;
  }

  private async processPendingTransactions(rawTransactions: unknown) {
    const pendingTransactions = PendingTransactionsResponse.parse(rawTransactions);

    if (!pendingTransactions.length) {
      logger.debug("No pending Rogers Bank transactions found");
      return;
    }

    logger.info(
      `Processing ${pendingTransactions.length} pending Rogers Bank transaction(s)`,
    );

    const uniquePendingTransactions = Array.from(
      new Map(
        pendingTransactions.map((transaction) => [transaction.activityId, transaction]),
      ).values(),
    );

    logger.info(
      `Deduplicated pending Rogers Bank transactions from ${pendingTransactions.length} raw to ${uniquePendingTransactions.length} unique`,
    );

    const seenActivityIds = new Set<string>();

    for (
      let i = 0;
      i < uniquePendingTransactions.length;
      i += MAX_BATCH_GET_KEYS
    ) {
      const batch = uniquePendingTransactions.slice(i, i + MAX_BATCH_GET_KEYS);
      const response = await docClient.send(
        new BatchGetCommand({
          RequestItems: {
            [PENDING_TRANSACTIONS_TABLE_NAME]: {
              Keys: batch.map(({ activityId }) => ({ activityId })),
              ProjectionExpression: "activityId",
            },
          },
        }),
      );

      const items =
        (response.Responses?.[PENDING_TRANSACTIONS_TABLE_NAME] as
          | Array<{ activityId: string }>
          | undefined) ?? [];

      for (const item of items) {
        seenActivityIds.add(item.activityId);
      }

      const unprocessedKeysCount =
        response.UnprocessedKeys?.[PENDING_TRANSACTIONS_TABLE_NAME]?.Keys
          ?.length ?? 0;
      if (unprocessedKeysCount) {
        logger.warn(
          `BatchGet returned ${unprocessedKeysCount} unprocessed pending transaction key(s)`,
        );
      }
    }

    const newPendingTransactions = uniquePendingTransactions.filter(
      ({ activityId }) => !seenActivityIds.has(activityId),
    );

    logger.info(
      `Pending Rogers Bank transaction dedupe results: ${seenActivityIds.size} seen, ${newPendingTransactions.length} new`,
    );

    if (!newPendingTransactions.length) {
      logger.info("No new pending Rogers Bank transactions to notify");
      return;
    }

    const successfullyNotifiedActivityIds: string[] = [];

    for (const transaction of newPendingTransactions) {
      const last4 = transaction.cardNumber.slice(-CARD_LAST4_LENGTH);
      const notification = `$${Math.abs(transaction.amount).toFixed(2)} at ${transaction.merchant} was approved on your ************${last4}`;

      try {
        const webhookResponse = await fetch(env.TRANSACTIONS_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            notification,
            bank: ROGERS_BANK_WEBHOOK_NAME,
          }),
        });

        if (!webhookResponse.ok) {
          logger.error(
            `Failed to send pending transaction webhook for activity ${transaction.activityId}: ${webhookResponse.status} ${webhookResponse.statusText}`,
          );
          continue;
        }

        successfullyNotifiedActivityIds.push(transaction.activityId);
        logger.info(
          `Sent pending transaction webhook for activity ${transaction.activityId}: $${Math.abs(transaction.amount).toFixed(2)} at ${transaction.merchant} on ************${last4}`,
        );
      } catch (error) {
        logger.error(
          `Failed to send pending transaction webhook for activity ${transaction.activityId}`,
          error,
        );
      }
    }

    if (!successfullyNotifiedActivityIds.length) {
      logger.warn(
        "Pending Rogers Bank transactions were found, but no webhook notifications succeeded",
      );
      return;
    }

    const expiresAt = Math.floor(Date.now() / 1000) + SEVEN_DAYS_IN_SECONDS;

    for (
      let i = 0;
      i < successfullyNotifiedActivityIds.length;
      i += MAX_BATCH_WRITE_ITEMS
    ) {
      const batch = successfullyNotifiedActivityIds.slice(
        i,
        i + MAX_BATCH_WRITE_ITEMS,
      );

      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [PENDING_TRANSACTIONS_TABLE_NAME]: batch.map((activityId) => ({
              PutRequest: {
                Item: {
                  activityId,
                  expiresAt,
                },
              },
            })),
          },
        }),
      );

      const unprocessedItemsCount =
        response.UnprocessedItems?.[PENDING_TRANSACTIONS_TABLE_NAME]?.length ??
        0;
      if (unprocessedItemsCount) {
        logger.warn(
          `BatchWrite returned ${unprocessedItemsCount} unprocessed pending transaction item(s)`,
        );
      }
    }

    logger.info(
      `Successfully sent ${successfullyNotifiedActivityIds.length} pending Rogers Bank transaction notification(s)`,
    );
  }

  private async fetchTransactions(
    accountId: string,
    customerId: string,
    accountName: string,
    accountUuid: string,
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
    });

    if (!transactionsResponse.ok) {
      throw new Error(
        `Failed to fetch transactions: ${transactionsResponse.statusText}`,
      );
    }

    const transactions = await transactionsResponse.json();

    if (env.PENDING_NOTIFICATIONS_ENABLED) {
      try {
        await this.processPendingTransactions(transactions);
      } catch (error) {
        logger.error(
          "Failed to process pending Rogers Bank transactions",
          error,
        );
      }
    }

    const postedTransactions = TransactionsResponse.parse(transactions);
    logger.info(
      `Fetched transactions for account ${accountName} (ID: ${accountUuid})`,
    );

    return postedTransactions;
  }

  private async login(username: string, password: string): Promise<void> {
    const page = await this.getPage();

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
      await page.getByRole("button", { name: "Sign in" }).click();

      const response = await page.waitForResponse(
        (response) =>
          response
            .url()
            .startsWith(
              "https://selfserve.apis.rogersbank.com/v1/authenticate/user/",
            ) && response.request().method() === "POST",
      );
      const isTwoFactorAuthenticationRequired = response.status() === 412;

      if (isTwoFactorAuthenticationRequired) {
        logger.debug("Two-factor authentication required");
        logger.debug("Filling in two-factor authentication code");
        await page.getByRole("radio", { name: "+" }).click();
        await page.getByRole("button", { name: "Send code" }).click();
        const code = await getSMSTwoFactorAuthenticationCode({
          afterDate: this.date,
          sender: "74979",
          regex: /\b\d{8}\b/,
        });
        await page
          .getByRole("textbox", { name: "Verification Code" })
          .fill(code);
        await page.getByRole("button", { name: "Continue" }).click();
      }
    }

    if (!isLoginRequired) {
      page.reload();
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
      account.id,
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
