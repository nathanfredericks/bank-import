import uuid
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field
from utils.env import env

class Account(BaseModel):
    accountId: str
    productName: str
    currentBalance: float
    customerId: str
    previousStatementDate: Optional[str] = None

    def transform(self):
        return {
            "id": str(uuid.uuid5(uuid.NAMESPACE_DNS, self.accountId)),
            "name": f"{self.productName} ({self.accountId})",
            "balance": self.currentBalance * -1,
            "_number": self.accountId,
            "_customerId": self.customerId,
            "_previousStatementDate": self.previousStatementDate,
        }

class UserResponse(BaseModel):
    accounts: List[Account]

    def transform(self):
        return [account.transform() for account in self.accounts]

class Transaction(BaseModel):
    amount: float
    date: str
    merchantName: str
    postedDate: str

    def transform(self):
        amount = self.amount * -1
        return {
            "date": self.postedDate if amount > 0 else self.date,
            "amount": amount,
            "description": self.merchantName,
        }

class ActivityResponse(BaseModel):
    activities: List[Transaction]

    def transform(self):
        return [transaction.transform() for transaction in self.activities if transaction.postedDate]
