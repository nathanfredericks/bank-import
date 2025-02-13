from datetime import datetime, timezone, timedelta
from uuid import uuid5
from pydantic import BaseModel, Field, validator
import env

class Account(BaseModel):
    type: str
    number: str
    account_balance: float
    display_name: str
    description: str
    id: str = Field(default_factory=lambda: uuid5(env.UUID_NAMESPACE, self.number))
    name: str = Field(default_factory=lambda: f"{self.description} ({self.display_name})")
    balance: float = Field(default_factory=lambda: self.account_balance * (-1 if self.type == "CREDIT_CARD" else 1))
    _number: str = Field(default_factory=lambda: self.number)

class AccountResponse(BaseModel):
    accounts: list[Account]

class Transaction(BaseModel):
    transaction_date: str
    posted_date: str
    amount: float
    description: str
    is_uncleared: bool
    status: str
    date: str = Field(default_factory=lambda: format_iso(self.posted_date if self.amount > 0 else self.transaction_date))

    @validator('date', pre=True, always=True)
    def format_iso(cls, v):
        return datetime.fromisoformat(v).astimezone(timezone(timedelta(hours=int(env.TZ)))).isoformat()

class TransactionsResponse(BaseModel):
    transactions: list[Transaction]

class DisplayChallengeQuestionResponse(BaseModel):
    MessageBody: dict

    @validator('MessageBody', pre=True, always=True)
    def extract_question(cls, v):
        return v['Question']
