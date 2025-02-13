import datetime
import uuid
import asyncio
from playwright.async_api import async_playwright
from dateutil import parser
from dateutil.relativedelta import relativedelta
from typing import List, Dict, Any
import logging
from utils.pushover import send_notification
from utils.s3 import upload_file
from banks.types import Account, bankName, BankName

class Bank:
    def __init__(self, bank: BankName):
        self.bank = bank
        self.context = None
        self.page = None
        self.date = datetime.datetime.now()
        self.accounts: List[Account] = []

    async def launch_browser(self):
        logging.debug("Launching browser")
        options = {
            "headless": False,
            "args": [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
            ],
        }
        async with async_playwright() as p:
            browser = await p.chromium.launch(**options)
            logging.debug("Creating new context")
            self.context = await browser.new_context()
            await self.start_tracing()
            logging.debug("Creating new page")
            self.page = await self.context.new_page()

    async def close_browser(self, tracing_file_path: str = None):
        await self.stop_tracing(tracing_file_path)
        logging.debug("Closing browser")
        await self.page.context.browser.close()
        self.page = None

    async def start_tracing(self):
        logging.debug("Starting tracing")
        await self.context.tracing.start(screenshots=True, snapshots=True)

    async def stop_tracing(self, file_path: str = None):
        logging.debug("Stopping tracing")
        await self.context.tracing.stop(path=file_path)

    async def handle_error(self, error: Exception):
        logging.error(error)
        trace_file_name = f"{self.date.strftime('%Y-%m-%d')}-{self.bank}-{uuid.uuid4()}.zip"
        trace_file_path = f"traces/{trace_file_name}"
        await self.close_browser(trace_file_path)
        logging.info(f"Saved trace to {trace_file_path}")
        with open(trace_file_path, "rb") as trace_file:
            await upload_file(trace_file_name, "application/zip", trace_file.read())
        await send_notification(
            f"Error fetching accounts from {bankName[self.bank]}.",
            {
                "title": "Error Fetching Accounts",
                "url": "https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups",
                "url_title": "Open AWS Console",
            },
        )

    async def get_cookies(self):
        if not self.page:
            raise Exception("Page is not initialized")
        return await self.page.context.cookies()

    async def get_cookies_as_string(self):
        cookies = await self.get_cookies()
        return "; ".join([f"{cookie['name']}={cookie['value']}" for cookie in cookies])

    async def get_cookie(self, name: str):
        cookies = await self.get_cookies()
        cookie = next((cookie['value'] for cookie in cookies if cookie['name'] == name), None)
        if not cookie:
            raise Exception(f'Cookie "{name}" not found')
        return cookie

    async def get_page(self):
        if not self.page:
            raise Exception("Page is not initialized")
        return self.page

    def get_accounts(self):
        return self.accounts

    def set_accounts(self, accounts: List[Account]):
        self.accounts = accounts
