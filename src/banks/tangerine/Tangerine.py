from datetime import datetime, timedelta
import requests
import logging
import secrets
from dateutil.parser import parse
from .schemas import Account, AccountResponse, DisplayChallengeQuestionResponse, TransactionsResponse
from ..Bank import Bank
from ..types import BankName
from ..utils import getSMSTwoFactorAuthenticationCode

class Tangerine(Bank):
    def __init__(self):
        super().__init__(BankName.Tangerine)

    @staticmethod
    async def create(loginID: str, pin: str):
        tangerine = Tangerine()
        try:
            await tangerine.launch_browser()
            await tangerine.login(loginID, pin)
            await tangerine.close_browser()
        except Exception as error:
            await tangerine.handle_error(error)
        return tangerine

    async def fetch_accounts(self):
        page = await self.get_page()

        logging.debug("Fetching accounts from Tangerine")
        response = await page.wait_for_response(
            lambda response: response.url == "https://secure.tangerine.ca/web/rest/pfm/v1/accounts" and response.request.method == "GET"
        )
        json = await response.json()
        accounts = AccountResponse.parse(json)
        logging.debug(f"Fetched {len(accounts)} accounts from Tangerine", accounts)

        cookies = response.request.headers.get("Cookie", "")

        return await asyncio.gather(
            *[self.fetch_transactions(account, cookies) for account in accounts]
        )

    async def fetch_transactions(self, account: Account, cookies: str):
        logging.debug(f"Fetching transactions for account {account.name}")
        response = requests.get(
            "https://secure.tangerine.ca/web/rest/pfm/v1/transactions",
            params={
                "accountIdentifiers": account._number,
                "hideAuthorizedStatus": "true",
                "periodFrom": (datetime.now() - timedelta(days=10)).isoformat(),
            },
            headers={"Cookie": cookies},
        )
        data = response.json()
        transactions = sorted(TransactionsResponse.parse(data), key=lambda x: parse(x.date), reverse=True)
        logging.debug(f"Fetched {len(transactions)} transaction(s) for account {account.name}", transactions)

        return transactions

    async def login(self, loginID: str, pin: str):
        page = await self.get_page()

        logging.debug("Navigating to Tangerine login page")
        await page.goto("https://www.tangerine.ca/app/#/login/login-id?locale=en_CA")

        logging.debug("Accepting cookies")
        await page.wait_for_selector("#onetrust-accept-btn-handler")
        await page.click("#onetrust-accept-btn-handler")

        logging.debug("Filling in login ID")
        await page.get_by_role("textbox", name="Login ID").fill(loginID)
        await page.get_by_role("button", name="Next").click()

        logging.debug("Waiting for response")
        response = await page.wait_for_response(
            lambda response: response.url.endswith("displayPIN") or response.url.endswith("displayChallengeQuestion") and response.request.method == "GET"
        )

        if response.url.endswith("displayChallengeQuestion"):
            logging.debug("Security question required")
            logging.debug("Filling in security question")
            json = await response.json()
            security_question = DisplayChallengeQuestionResponse.parse(json)
            security_answer = secrets.TANGERINE_SECURITY_QUESTIONS.get(security_question)
            if not security_answer:
                raise ValueError(f"Security question not found: {security_question}")
            await page.get_by_role("textbox", name="Answer").fill(security_answer)
            await page.get_by_role("button", name="Next", exact=True).click()

        logging.debug("Filling in PIN")
        await page.get_by_role("textbox", name="PIN").fill(pin)
        await page.get_by_role("button", name="Log In").click()

        await page.wait_for_url(
            lambda url: url in [
                "https://www.tangerine.ca/app/#/accounts?locale=en_CA",
                "https://www.tangerine.ca/app/#/login/two-factor-authentication?locale=en_CA",
                "https://www.tangerine.ca/app/#/login/security-code?locale=en_CA",
            ]
        )

        if page.url in [
            "https://www.tangerine.ca/app/#/login/two-factor-authentication?locale=en_CA",
            "https://www.tangerine.ca/app/#/login/security-code?locale=en_CA",
        ]:
            logging.debug("Two-factor authentication required")
            logging.debug("Filling in two-factor authentication code")
            code = await getSMSTwoFactorAuthenticationCode(self.date, "tangerine")
            await page.get_by_role("textbox", name="Security Code").fill(code)
            await page.get_by_role("button", name="Log In").click()

        accounts = await self.fetch_accounts()
        self.set_accounts([account for account in accounts if account])

