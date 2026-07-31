import { presentMfaChallenge } from "../../auth/handoff";
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
      await nbdb.saveBrowserState();
      await nbdb.closeBrowser();
    } catch (error) {
      if (error instanceof Error) {
        await nbdb.handleError(error);
        throw error;
      } else {
        throw error;
      }
    }
    return nbdb;
  }

  private async fillUserIDAndPassword(userID: string, password: string) {
    const page = await this.getPage();
    logger.debug("Filling in user ID and password");
    await page
      .getByRole("textbox", { name: "User ID" })
      .pressSequentially(userID);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("checkbox", { name: "Remember me" }).click();
  }

  private async fillPassword(password: string) {
    const page = await this.getPage();
    logger.debug("Filling in password");
    await page
      .getByRole("textbox", { name: "Enter your password" })
      .fill(password);
  }

  private async login(userID: string, password: string) {
    const page = await this.getPage();

    await page.route("https://sdk.privacy-center.org/**", (route) =>
      route.abort(),
    );

    logger.debug("Navigating to NBDB login page");
    await page.goto("https://client.bnc.ca/nbdb/login");

    await page.waitForSelector("#password-hidden");

    const userIDTextbox = page.getByRole("textbox", {
      name: "Enter your user ID",
    });
    if (await userIDTextbox.isVisible()) {
      await this.clearRestoredBrowserState();
      await this.fillUserIDAndPassword(userID, password);
    } else {
      await this.fillPassword(password);
    }

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
      const handoff = await presentMfaChallenge(BankName.NBDB, [
        { id: "email", label: "Email" },
      ]);
      const method = await handoff.waitForMethod();
      if (method !== "email") {
        await handoff.fail("This verification method is not supported");
        throw new Error("Unsupported NBDB verification method");
      }
      await page.getByRole("link", { name: "Email" }).click();
      handoff.requestCode();
      const code = await handoff.waitForCode();
      await page.getByRole("textbox", { name: "Verification code" }).fill(code);
      await page.getByRole("button", { name: "Confirm" }).click();
      await handoff.complete();
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

    for (const account of summary) {
      logger.info(`Fetched account ${account.name} (ID: ${account.id})`);
    }

    this.setAccounts(summary);
  }
}
