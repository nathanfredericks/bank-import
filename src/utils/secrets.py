import boto3
import json
from botocore.exceptions import ClientError
from pydantic import BaseModel, Field
from typing import Dict

from src.utils.env import env

class Secrets(BaseModel):
    VOIPMS_API_USERNAME: str
    VOIPMS_API_PASSWORD: str
    VOIPMS_DID: str
    TANGERINE_LOGIN_ID: str
    TANGERINE_PIN: str
    MANULIFE_BANK_USERNAME: str
    MANULIFE_BANK_PASSWORD: str
    BMO_CARD_NUMBER: str
    BMO_PASSWORD: str
    YNAB_ACCESS_TOKEN: str
    JMAP_BEARER_TOKEN: str
    ROGERS_BANK_USERNAME: str
    ROGERS_BANK_PASSWORD: str
    TANGERINE_SECURITY_QUESTIONS: Dict[str, str]
    MESSAGES_API_KEY: str
    PUSHOVER_TOKEN: str
    PUSHOVER_USER: str

def get_secret():
    secret_name = env.SECRET_NAME
    region_name = env.AWS_DEFAULT_REGION

    # Create a Secrets Manager client
    session = boto3.session.Session()
    client = session.client(
        service_name='secretsmanager',
        region_name=region_name,
        aws_access_key_id=env.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=env.AWS_SECRET_ACCESS_KEY
    )

    try:
        get_secret_value_response = client.get_secret_value(
            SecretId=secret_name
        )
    except ClientError as e:
        raise e

    # Decrypts secret using the associated KMS key.
    secret = get_secret_value_response['SecretString']

    return json.loads(secret)

secrets = Secrets(**get_secret())
