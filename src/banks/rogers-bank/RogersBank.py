from dateutil.parser import parse as parseISO
from datetime import datetime, timedelta
from typing import List, Optional
from utils.2fa import getEmailTwoFactorAuthenticationCode
import requests
import logging
from banks.Bank import Bank
from banks.types import BankName
from banks.rogers-bank.schemas import Account, ActivityResponse, UserResponse

class RogersBank(Bank):
    def __init__(self):
        super().__init__(BankName.RogersBank)

    @staticmethod
    async def create(username: str, password: str):
        rogersBank = RogersBank()
        try:
            await rogersBank.launchBrowser()
            await rogersBank.login(username, password)
            await rogersBank.closeBrowser()
        except Exception as error:
            await rogersBank.handleError(error)
        return rogersBank

    async def fetchTransactions(self, account: Account):
        logging.debug(f"Fetching transactions for account {account.name}")
        response = requests.get(
            f"https://rbaccess.rogersbank.com/issuing/digital/account/{account._number}/customer/{account._customerId}/activity",
            headers={
                "Cookie": await self.getCookiesAsString(),
            },
        )

        data = response.json()
        transactions = ActivityResponse.parse(data)
        transactions = [
            transaction for transaction in transactions
            if parseISO(transaction.date) >= self.date - timedelta(days=10) and parseISO(transaction.date) <= self.date
        ]
        transactions.sort(key=lambda transaction: parseISO(transaction.date), reverse=True)
        logging.debug(
            f"Fetched {len(transactions)} transaction(s) for account {account.name}",
            transactions,
        )

        return transactions

    async def processAccounts(self, accounts: Optional[List[Account]]):
        if not accounts:
            return

        accountsWithTransactions = await asyncio.gather(
            *[self.fetchTransactions(account) for account in accounts]
        )

        self.setAccounts(
            [
                {k: v for k, v in account.items() if k not in ["_number", "_customerId", "_previousStatementDate"]}
                for account in accountsWithTransactions
            ]
        )

    async def login(self, username: str, password: str):
        page = await self.getPage()
        logging.debug("Navigating to Rogers Bank login page")
        await page.goto(
            "https://rbaccess.rogersbank.com/?product=ROGERSBRAND&locale=en_CA"
        )

        logging.debug("Filling in username and password")
        await page.get_by_role("textbox", name="Username").fill(username)
        await page.get_by_role("textbox", name="Password").fill(password)
        await page.get_by_role("button", name="Sign In").click()

        logging.debug("Waiting for response")
        response = await page.wait_for_response(
            lambda response: response.url == "https://rbaccess.rogersbank.com/issuing/digital/authenticate/user"
            and response.request.method == "POST"
        )

        isTwoFactorAuthenticationRequired = response.status == 401

        if isTwoFactorAuthenticationRequired:
            logging.debug("Two-factor authentication required")
            logging.debug("Filling in two-factor authentication code")
            await page.get_by_role("radio", name="@").click()
            await page.get_by_role("button", name="Send code").click()
            code = await getEmailTwoFactorAuthenticationCode(
                self.date,
                "onlineservices@RogersBank.com",
                "Your verification code",
            )
            await page.get_by_role("button", name="OK").click()
            await page.get_by_role("textbox", name="One-time passcode").fill(code)
            await page.get_by_role("button", name="Continue").click()

            logging.debug("Waiting for response")
            response = await page.wait_for_response(
                lambda response: response.url == "https://rbaccess.rogersbank.com/issuing/digital/authenticate/validatepasscode"
                and response.request.method == "POST"
            )
            json = await response.json()
            accounts = UserResponse.parse(json)

            await self.processAccounts(accounts)
        else:
            json = await response.json()
            accounts = UserResponse.parse(json)

            await self.processAccounts(accounts)
