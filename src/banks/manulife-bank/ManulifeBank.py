from dateutil import tz
from datetime import datetime, timedelta
import json
from utils.2fa import get_email_two_factor_authentication_code
from utils.logger import logger
from banks.Bank import Bank
from banks.types import BankName
from banks.manulife_bank.schemas import Account, AccountResponse, TransactionsResponse

class ManulifeBank(Bank):
    def __init__(self):
        super().__init__(BankName.MANULIFE_BANK)

    @staticmethod
    async def create(username: str, password: str):
        manulife_bank = ManulifeBank()
        try:
            await manulife_bank.launch_browser()
            await manulife_bank.login(username, password)
            await manulife_bank.close_browser()
        except Exception as error:
            await manulife_bank.handle_error(error)
        return manulife_bank

    async def fetch_accounts(self):
        page = await self.get_page()

        logger.debug("Fetching accounts from Manulife Bank")
        response = await page.wait_for_response(
            lambda response: response.url == "https://online.manulifebank.ca/api/v2/accounts/" and response.request.method == "GET"
        )
        json_data = await response.json()
        accounts = AccountResponse.parse(json_data)
        logger.debug(f"Fetched {len(accounts)} account(s) from Manulife Bank", accounts)

        return await asyncio.gather(
            *[self.fetch_transactions(account, response.request.headers) for account in accounts]
        )

    async def fetch_transactions(self, account: Account, headers: dict):
        page = await self.get_page()

        logger.debug(f"Fetching transactions for account {account.name}")
        start_date = (self.date - timedelta(days=10)).isoformat()
        end_date = self.date.isoformat()
        json_data = await page.evaluate(
            """async ({ account, headers, start_date, end_date }) => {
                const response = await fetch(
                    `https://online.manulifebank.ca/api/v2/accounts/history/${account._index}/start/${start_date}/end/${end_date}`,
                    {
                        headers: {
                            ...headers,
                        },
                    },
                );
                return await response.json();
            }""",
            {"account": account, "headers": headers, "start_date": start_date, "end_date": end_date},
        )
        transactions = sorted(TransactionsResponse.parse(json_data), key=lambda x: datetime.fromisoformat(x.date), reverse=True)
        logger.debug(f"Fetched {len(transactions)} transaction(s) for account {account.name}", transactions)

        return transactions

    async def login(self, username: str, password: str):
        page = await self.get_page()

        logger.debug("Navigating to Manulife Bank login page")
        await page.goto("https://online.manulifebank.ca/accounts")

        await page.get_by_role("button", name="Sign in").click()

        logger.debug("Filling in username and password")
        await page.wait_for_load_state("networkidle")
        await page.get_by_role("textbox", name="Username").click()
        await page.get_by_role("textbox", name="Username").press_sequentially(username, delay=100)
        await page.get_by_role("textbox", name="Password").click()
        await page.get_by_role("textbox", name="Password").press_sequentially(password, delay=100)
        await page.get_by_role("button", name="Sign In").click()

        logger.debug("Waiting for response")
        await page.wait_for_url(
            lambda url: url.startswith("https://id.manulife.ca/otp-on-demand") or url.startswith("https://id.manulife.ca/mfa") or url == "https://online.manulifebank.ca/init"
        )

        is_two_factor_authentication_required = page.url != "https://online.manulifebank.ca/init"

        if is_two_factor_authentication_required:
            logger.debug("Two-factor authentication required")
            logger.debug("Filling in two-factor authentication code")
            await page.get_by_role("button", name="Email").click()
            code = await get_email_two_factor_authentication_code(
                self.date,
                "donotreply@manulife.com",
                "Here's the code",
            )
            await page.get_by_role("textbox", name="Code").press_sequentially(code)
            await page.get_by_role("button", name="Continue").click()

            accounts = await self.fetch_accounts()
            self.set_accounts([account for account in accounts if account._index])
        else:
            accounts = await self.fetch_accounts()
            self.set_accounts([account for account in accounts if account._index])
