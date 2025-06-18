import { getEmailTwoFactorAuthenticationCode } from "../../utils/2fa";
import logger from "../../utils/logger";
import { Bank } from "../Bank";
import { BankName } from "../types";
import { AuthnResponse, SummaryResponse } from "./schemas";

export class NBDB extends Bank {
  constructor() {
    super(BankName.NBDB);
  }

  public static async create(userID: string, password: string) {
    const nbdb = new NBDB();
    try {
      await nbdb.launchBrowser();
      await nbdb.login(userID, password);
      await nbdb.closeBrowser();
    } catch (error) {
      if (error instanceof Error) {
        await nbdb.handleError(error);
      } else {
        throw error;
      }
    }
    return nbdb;
  }

  private async login(userID: string, password: string) {
    const page = await this.getPage();
    logger.debug("Navigating to NBDB login page");
    await page.goto("https://client.bnc.ca/nbdb/login");

    logger.debug("Accepting cookies");
    await page.getByText("Accept").click();

    logger.debug("Filling in user ID and password");
    await page
      .getByRole("textbox", { name: "User ID" })
      .pressSequentially(userID);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    logger.debug("Waiting for response");
    const authnResponse = await page.waitForResponse(
      (response) =>
        response.url() ===
          "https://api.bnc.ca/bnc/prod-okta/sso/api/v1/authn" &&
        response.request().method() === "POST",
    );
    const json = await authnResponse.json();
    const isTwoFactorAuthenticationRequired = AuthnResponse.parse(json);

    if (isTwoFactorAuthenticationRequired) {
      logger.debug("Two-factor authentication required");
      logger.debug("Filling in two-factor authentication code");
      await page.getByRole("link", { name: "Email" }).click();
      const code = await getEmailTwoFactorAuthenticationCode({
        afterDate: this.date,
        sender: "noreply@appbnc.ca",
        subject: "Here's your verification code",
      });
      await page.getByRole("textbox", { name: "Verification code" }).fill(code);
      await page.getByRole("button", { name: "Confirm" }).click();
    }

    const summaryResponse = await page.waitForResponse(
      (response) =>
        response
          .url()
          .startsWith(
            "https://iiroc.investments.apis.bnc.ca/orion-api/v1/1/portfolios/summary",
          ) && response.request().method() === "GET",
    );
    const summaryJson = await summaryResponse.json();
    const summary = SummaryResponse.parse(summaryJson);

    this.setAccounts(summary);
  }
}
