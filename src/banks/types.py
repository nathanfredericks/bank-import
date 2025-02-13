from pydantic import BaseModel, Field
from typing import List
from datetime import date

class Transaction(BaseModel):
    date: date
    description: str
    amount: float

class Account(BaseModel):
    id: str
    name: str
    balance: float
    transactions: List[Transaction]

class BankName(str):
    BMO = "bmo"
    Tangerine = "tangerine"
    ManulifeBank = "manulife-bank"
    RogersBank = "rogers-bank"

bankName = {
    BankName.BMO: "BMO",
    BankName.Tangerine: "Tangerine",
    BankName.ManulifeBank: "Manulife Bank",
    BankName.RogersBank: "Rogers Bank",
}
