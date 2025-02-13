from dateutil import tz
from datetime import datetime
from uuid import uuid5
from pydantic import BaseModel, Field
import env

class Account(BaseModel):
    id: str
    displayName: str
    accountId: dict
    balance: float

    def transform(self):
        return {
            "id": str(uuid5(env.UUID_NAMESPACE, self.accountId["accountNumber"])),
            "name": f"{self.displayName} ({self.accountId['accountNumber']})",
            "balance": self.balance,
            "_index": self.id,
        }

class AccountResponse(BaseModel):
    assetAccounts: dict

    def transform(self):
        accounts = self.assetAccounts["assetAccount"]
        return [Account(**account).transform() for account in accounts]

class Transaction(BaseModel):
    date: int
    description: str
    transactionAmount: float

    def transform(self):
        date = datetime.fromtimestamp(self.date / 1000, tz=tz.gettz(env.TZ))
        return {
            "date": date.isoformat(),
            "amount": self.transactionAmount,
            "description": self.description,
        }

class TransactionsResponse(BaseModel):
    historyTransactions: dict

    def transform(self):
        transactions = self.historyTransactions["transaction"]
        return [Transaction(**transaction).transform() for transaction in transactions]
