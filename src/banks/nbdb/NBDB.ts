import { BankFailure } from "../../sessions/types";
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
      await nbdb.restoreSavedSession();
      await nbdb.login(userID, password);
      await nbdb.persistSession();
      await nbdb.closeBrowser();
    } catch (error) {
      if (error instanceof Error) {
        await nbdb.logLoginDiagnostics(error).catch(() => {});
        await nbdb.handleError(error);
      }
      throw error;
    }
    return nbdb;
  }

  private async logLoginDiagnostics(error: Error) {
    const page = await this.getPage();
    // Only fixed labels and booleans; never input values, page text, or API bodies.
    logger.debug(
      `NBDB failure category: ${error.name === "TimeoutError" ? "timeout" : "operation-error"}`,
    );
    logger.debug(
      `NBDB login form visible: ${await page
        .locator("#password-hidden")
        .isVisible()
        .catch(() => false)}`,
    );
    logger.debug(
      `NBDB update banner visible: ${await page
        .getByText("Ignore the update", { exact: true })
        .isVisible()
        .catch(() => false)}`,
    );
    logger.debug(
      `NBDB credential rejection visible: ${await page
        .getByText(/incorrect|invalid password|unable to sign in/i)
        .first()
        .isVisible()
        .catch(() => false)}`,
    );
  }

  private async fillUserIDAndPassword(userID: string, password: string) {
    const page = await this.getPage();
    logger.debug("Filling in user ID and password");
    await page.locator("#username").pressSequentially(userID);
    await page.locator("#password-hidden").fill(password);
  }

  private async fillPassword(password: string) {
    const page = await this.getPage();
    logger.debug("Filling in password");
    await page.locator("#password-hidden").fill(password);
  }

  private async dismissBrowserUpdate() {
    const page = await this.getPage();
    const ignoreUpdate = page.getByText("Ignore the update", { exact: true });
    try {
      // The banner is asynchronous and can appear after the password field.
      await ignoreUpdate.waitFor({ state: "visible", timeout: 5_000 });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") return;
      throw error;
    }
    await ignoreUpdate.click();
    await ignoreUpdate.waitFor({ state: "hidden", timeout: 10_000 });
    logger.debug("NBDB browser-update banner dismissed");
  }

  private async login(userID: string, password: string) {
    const page = await this.getPage();
    const summaryPending = page.waitForResponse(
      (response) =>
        response
          .url()
          .startsWith(
            "https://iiroc.investments.apis.bnc.ca/orion-api/v1/1/portfolios/summary",
          ) && response.request().method() === "GET",
      { timeout: 180_000 },
    );
    void summaryPending.catch(() => {});

    await page.route("https://sdk.privacy-center.org/**", (route) =>
      route.abort(),
    );

    logger.debug("Navigating to NBDB login page");
    await page.goto("https://client.bnc.ca/nbdb/login");

    const restored = await Promise.race([
      summaryPending.then((response) => response.ok()),
      page.waitForSelector("#password-hidden").then(() => false),
    ]);
    if (restored) {
      this.setAccounts(
        SummaryResponse.parse(await (await summaryPending).json()),
      );
      return;
    }
    this.diagnosticStage = "browser-update-banner";
    await this.dismissBrowserUpdate();
    this.diagnosticStage = "login-fill";
    // Password inputs have no implicit textbox role; placeholders are not accessible names.
    const userIDTextbox = page.locator("#username");
    if (await userIDTextbox.isVisible()) {
      await this.fillUserIDAndPassword(userID, password);
    } else {
      await this.fillPassword(password);
    }

    // Fail before submitting if an overlay intercepted any typing.
    if (
      (await page.locator("#password-hidden").inputValue()) !== password ||
      ((await userIDTextbox.isVisible()) &&
        (await userIDTextbox.inputValue()) !== userID)
    )
      throw new Error("NBDB form entry did not complete");

    logger.debug("Waiting for response");
    this.diagnosticStage = "login-submit";
    const authnPending = page.waitForResponse(
      (response) =>
        response.url() ===
          "https://api.bnc.ca/bnc/prod-okta/sso/api/v1/authn" &&
        response.request().method() === "POST",
    );
    void authnPending.catch(() => {});
    await page
      .locator("button")
      .filter({ hasText: /^Sign in$/ })
      .click();
    this.diagnosticStage = "login-response";
    logger.debug("NBDB sign-in submitted");
    const authnResponse = await authnPending;
    logger.debug(`NBDB authentication response HTTP ${authnResponse.status()}`);
    if (!authnResponse.ok()) {
      const rejected = await authnResponse.json().catch(() => ({}));
      if (rejected.errorCode === "E0000004")
        throw new BankFailure("credentials-rejected");
      throw new BankFailure(
        authnResponse.status() === 429 ? "throttled" : "transport-failed",
      );
    }
    const json = await authnResponse.json();
    const isTwoFactorAuthenticationRequired = AuthnResponse.parse(json);

    if (isTwoFactorAuthenticationRequired) {
      this.diagnosticStage = "email-request";
      logger.debug("Two-factor authentication required");
      logger.debug("Filling in two-factor authentication code");
      const requestedAt = new Date();
      await page
        .getByRole("link", { name: "Email" })
        .waitFor({ state: "visible" })
        .catch(() => {
          throw new BankFailure("challenge-required");
        });
      await page.getByRole("link", { name: "Email" }).click();
      this.diagnosticStage = "email-poll";
      const code = await getEmailTwoFactorAuthenticationCode({
        afterDate: requestedAt,
        sender: "noreply@appbnc.ca",
        subject: "Here’s your verification code",
        codeLength: 6,
      });
      this.diagnosticStage = "email-entry";
      logger.debug("NBDB verification email received");
      await page.getByRole("textbox", { name: "Verification code" }).fill(code);
      await page.getByRole("button", { name: "Confirm" }).click();
    }

    this.diagnosticStage = "account-discovery";
    const summaryResponse = await summaryPending;
    const summaryJson = await summaryResponse.json();
    const summary = SummaryResponse.parse(summaryJson);

    for (const account of summary) {
      logger.info(`Fetched account ${account.name} (ID: ${account.id})`);
    }

    this.setAccounts(summary);
  }
}
