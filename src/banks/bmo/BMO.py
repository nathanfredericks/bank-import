from dateutil import tz
from datetime import datetime, timedelta
import uuid
from zod import z
from utils.2fa import getEmailTwoFactorAuthenticationCode
import requests
import logging
from banks.Bank import Bank
from banks.types import BankName
from banks.bmo.schemas import (
    Account,
    AuthenticateResponse,
    BankAccountTransactionsResponse,
    CreditCardTransactionsResponse,
    VerifyCredentialResponse,
    VerifyTwoFactorAuthenticationCodeResponse,
)

class BMO(Bank):
    def __init__(self):
        super().__init__(BankName.BMO)

    @staticmethod
    async def create(cardNumber: str, password: str):
        bmo = BMO()
        try:
            await bmo.launchBrowser()
            await bmo.login(cardNumber, password)
            await bmo.closeBrowser()
        except Exception as error:
            await bmo.handleError(error)
        return bmo

    async def generateRequestHeaders(self):
        page = await self.getPage()
        date = datetime.now()

        def generateHTTPRequestID():
            uuid_str = str(uuid.uuid4())
            return f"REQ_{uuid_str.replace('-', '').lower()[:20]}"

        return {
            "ver": "1.0",
            "channelType": "OLB",
            "appName": "OLB",
            "hostName": "BDBN-HostName",
            "clientDate": date.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3],
            "rqUID": generateHTTPRequestID(),
            "clientSessionID": "session-id",
            "userAgent": await page.evaluate("navigator.userAgent"),
            "clientIP": "127.0.0.1",
            "mfaDeviceToken": await self.getCookie("PMData"),
        }

    async def fetchTransactions(self, account: z.infer[Account]):
        if account._type not in ["BANK_ACCOUNT", "CREDIT_CARD"]:
            return []

        logging.debug(f"Fetching transactions for account {account.name}")
        url = (
            "https://www1.bmo.com/banking/services/accountdetails/getBankAccountDetails"
            if account._type == "BANK_ACCOUNT"
            else "https://www1.bmo.com/banking/services/accountdetails/getCCAccountDetails"
        )
        filters = (
            {
                "filterFromDate": (datetime.now() - timedelta(days=10)).strftime("%Y-%m-%d"),
                "filterToDate": datetime.now().strftime("%Y-%m-%d"),
            }
            if account._type == "BANK_ACCOUNT"
            else {"filter": "unbilled"}
        )
        response = requests.post(
            url,
            json={
                "MySummaryRq": {
                    "HdrRq": await self.generateRequestHeaders(),
                    "BodyRq": {
                        "accountIndex": account._index,
                        "limitNoTxns": "1500",
                        **filters,
                    },
                },
            },
            headers={
                "X-XSRF-TOKEN": await self.getCookie("XSRF-TOKEN"),
                "Cookie": await self.getCookiesAsString(),
            },
        )
        data = response.json()
        transactions = (
            BankAccountTransactionsResponse.parse(data)
            if account._type == "BANK_ACCOUNT"
            else CreditCardTransactionsResponse.parse(data)
        )
        transactions = [
            transaction
            for transaction in transactions
            if datetime.fromisoformat(transaction.date) >= datetime.now() - timedelta(days=10)
        ]
        transactions.sort(key=lambda x: datetime.fromisoformat(x.date), reverse=True)
        logging.debug(
            f"Fetched {len(transactions)} transaction(s) for account {account.name}",
            transactions,
        )

        return transactions

    async def processAccounts(self, accounts: list[z.infer[Account]] | None):
        if not accounts:
            return

        accountsWithTransactions = await asyncio.gather(
            *[self.fetchTransactions(account) for account in accounts]
        )

        self.setAccounts(
            [
                {k: v for k, v in account.items() if k not in ["_index", "_type"]}
                for account in accountsWithTransactions
            ]
        )

    async def login(self, cardNumber: str, password: str):
        page = await self.getPage()
        logging.debug("Navigating to BMO login page")
        await page.goto("https://www1.bmo.com/banking/digital/login")

        logging.debug("Filling in card number and password")
        await page.get_by_role("textbox", name="Card number").pressSequentially(cardNumber)
        await page.get_by_role("textbox", name="Password").fill(password)
        await page.get_by_role("button", name="Sign in").click()

        logging.debug("Waiting for response")
        verifyCredentialResponse = await page.wait_for_response(
            lambda response: response.url == "https://www1.bmo.com/banking/services/signin/verifyCredential"
            and response.request.method == "POST"
        )
        json = await verifyCredentialResponse.json()
        verifyCredentialData = VerifyCredentialResponse.parse(json)
        accounts = verifyCredentialData.accounts
        isTwoFactorAuthenticationRequired = verifyCredentialData.isTwoFactorAuthenticationRequired

        if isTwoFactorAuthenticationRequired:
            logging.debug("Two-factor authentication required")
            logging.debug("Filling in two-factor authentication code")
            await page.get_by_role("button", name="Next").click()
            await page.get_by_role("radio", name="Email").click()
            await page.get_by_role("checkbox", name="IMPORTANT: To proceed, you must confirm you will not provide this verification code to anyone.").click()
            await page.get_by_role("button", name="Send code").click()
            code = await getEmailTwoFactorAuthenticationCode(
                datetime.now(), "bmoalerts@bmo.com", "BMO Verification Code"
            )
            await page.get_by_role("textbox", name="Verification code").fill(code)
            await page.get_by_role("button", name="Confirm").click()

            logging.debug("Waiting for response")
            verifyResponse = await page.wait_for_response(
                lambda response: response.url.startswith("https://www1.bmo.com/aac/sps/authsvc")
                and response.url.endswith("&operation=verify")
                and response.request.method == "POST"
            )
            verifyJson = await verifyResponse.json()
            isTrustedDevice = VerifyTwoFactorAuthenticationCodeResponse.parse(verifyJson)

            if not isTrustedDevice:
                await page.get_by_role("button", name="Continue").click()

            logging.debug("Waiting for response")
            authenticateResponse = await page.wait_for_response(
                lambda response: response.url == "https://www1.bmo.com/banking/services/signin/authenticate"
                and response.request.method == "POST"
            )
            authenticateJson = await authenticateResponse.json()
            accounts = AuthenticateResponse.parse(authenticateJson)

            await self.processAccounts(accounts)
        else:
            await self.processAccounts(accounts)
