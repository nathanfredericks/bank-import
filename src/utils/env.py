import os
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from typing import Optional
from src.banks.types import BankName

load_dotenv()

class Env(BaseModel):
    YNAB_BUDGET_ID: str
    DEBUG: Optional[bool] = Field(default=None)
    TZ: str
    UUID_NAMESPACE: str
    JMAP_SESSION_URL: str
    SECRET_NAME: str
    AWS_ACCESS_KEY_ID: Optional[str] = Field(default=None)
    AWS_SECRET_ACCESS_KEY: Optional[str] = Field(default=None)
    AWS_DEFAULT_REGION: Optional[str] = Field(default=None)
    BANK: BankName
    AWS_S3_BUCKET_NAME: Optional[str] = Field(default=None)

env = Env(
    YNAB_BUDGET_ID=os.getenv("YNAB_BUDGET_ID"),
    DEBUG=os.getenv("DEBUG", "false").lower() in ("true", "1", "t"),
    TZ=os.getenv("TZ"),
    UUID_NAMESPACE=os.getenv("UUID_NAMESPACE"),
    JMAP_SESSION_URL=os.getenv("JMAP_SESSION_URL"),
    SECRET_NAME=os.getenv("SECRET_NAME"),
    AWS_ACCESS_KEY_ID=os.getenv("AWS_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY=os.getenv("AWS_SECRET_ACCESS_KEY"),
    AWS_DEFAULT_REGION=os.getenv("AWS_DEFAULT_REGION"),
    BANK=BankName(os.getenv("BANK")),
    AWS_S3_BUCKET_NAME=os.getenv("AWS_S3_BUCKET_NAME"),
)
