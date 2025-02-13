import uuid
from pydantic import BaseModel, Field, validator
from typing import List, Optional
from datetime import datetime
import env

class Account(BaseModel):
    accountNumber: str
    productName: str
    accountBalance: float
    accountIndex: int
    accountType: str

    @validator('id', pre=True, always=True)
    def set_id(cls, v, values):
        return str(uuid.uuid5(uuid.UUID(env.UUID_NAMESPACE), values['accountNumber']))

    @validator('balance', pre=True, always=True)
    def set_balance(cls, v, values):
        return values['accountBalance'] * (-1 if values['accountType'] == 'CREDIT_CARD' else 1)

    id: str = Field(default_factory=str)
    name: str = Field(default_factory=str)
    balance: float = Field(default_factory=float)
    _index: int = Field(default_factory=int)
    _type: str = Field(default_factory=str)

    @validator('name', pre=True, always=True)
    def set_name(cls, v, values):
        return f"{values['productName']} ({values['accountNumber']})"

class BaseCategory(BaseModel):
    products: Optional[List[Account]]

class NestedCategory(BaseCategory):
    categoryName: str

class InvestmentsCategory(BaseCategory):
    categoryName: str
    categories: List[NestedCategory]

    @validator('products', pre=True, always=True)
    def set_products(cls, v, values):
        nested_accounts = [account for category in values['categories'] for account in category.products or []]
        return (values['products'] or []) + nested_accounts

class CategoryName(str):
    BA = "BA"
    CC = "CC"
    LM = "LM"
    IN = "IN"

class Category(BaseCategory):
    categoryName: CategoryName

class VerifyCredentialResponse(BaseModel):
    isTwoFactorAuthenticationRequired: bool
    accounts: Optional[List[Account]]

    @validator('isTwoFactorAuthenticationRequired', pre=True, always=True)
    def set_isTwoFactorAuthenticationRequired(cls, v, values):
        return values['VerifyCredentialRs']['BodyRs']['isOTPSignIn'] == 'Y'

    @validator('accounts', pre=True, always=True)
    def set_accounts(cls, v, values):
        categories = values['VerifyCredentialRs']['BodyRs']['mySummary'].get('categories', [])
        return [account for category in categories for account in category.products or []]

class AuthenticateResponse(BaseModel):
    accounts: List[Account]

    @validator('accounts', pre=True, always=True)
    def set_accounts(cls, v, values):
        categories = values['AuthenticateRs']['BodyRs']['mySummary']['categories']
        return [account for category in categories for account in category.products or []]

class VerifyTwoFactorAuthenticationCodeResponse(BaseModel):
    deviceBound: bool

    @validator('deviceBound', pre=True, always=True)
    def set_deviceBound(cls, v, values):
        return values['SignOnOTPRs']['BodyRs']['deviceBound']

class BankAccountTransaction(BaseModel):
    txnDate: str
    descr: str
    txnAmount: str

    @validator('date', pre=True, always=True)
    def set_date(cls, v, values):
        return values['txnDate']

    @validator('description', pre=True, always=True)
    def set_description(cls, v, values):
        return values['descr'].replace('\s+', ' ').strip()

    @validator('amount', pre=True, always=True)
    def set_amount(cls, v, values):
        return float(values['txnAmount'])

    date: str = Field(default_factory=str)
    description: str = Field(default_factory=str)
    amount: float = Field(default_factory=float)

class BankAccountTransactionsResponse(BaseModel):
    bankAccountTransactions: List[BankAccountTransaction]

    @validator('bankAccountTransactions', pre=True, always=True)
    def set_bankAccountTransactions(cls, v, values):
        return values['GetBankAccountDetailsRs']['BodyRs']['bankAccountTransactions']

class CreditCardTransaction(BaseModel):
    txnDate: datetime
    postDate: datetime
    descr: str
    txnIndicator: Optional[str]
    amount: float

    @validator('date', pre=True, always=True)
    def set_date(cls, v, values):
        isCredit = values.get('txnIndicator') == 'CR'
        return values['postDate'] if isCredit else values['txnDate']

    @validator('amount', pre=True, always=True)
    def set_amount(cls, v, values):
        isCredit = values.get('txnIndicator') == 'CR'
        return values['amount'] * (1 if isCredit else -1)

    @validator('description', pre=True, always=True)
    def set_description(cls, v, values):
        return values['descr'].replace('\s+', ' ').strip()

    date: datetime = Field(default_factory=datetime)
    description: str = Field(default_factory=str)
    amount: float = Field(default_factory=float)

class CreditCardTransactionsResponse(BaseModel):
    lendingTransactions: List[CreditCardTransaction]

    @validator('lendingTransactions', pre=True, always=True)
    def set_lendingTransactions(cls, v, values):
        transactions = values['GetCCAccountDetailsRs']['BodyRs']['lendingTransactions']
        return [transaction for transaction in transactions if transaction.postDate]

