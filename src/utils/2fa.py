import requests
from html2text import html2text
from jmap_jam import JamClient
from retry import retry
from .env import env
from .logger import logger
from .secrets import secrets
from .types import Response

jam = JamClient(
    session_url=env.JMAP_SESSION_URL,
    bearer_token=secrets.JMAP_BEARER_TOKEN,
)
TWO_FACTOR_AUTHENTICATION_CODE_REGEX = r"\b\d{6}\b|\b\d{8}\b"

@retry(tries=float('inf'), delay=1, timeout=60)
def get_sms_two_factor_authentication_code(after_date, sender=None):
    logger.debug("Fetching SMS/MMS messages")
    response = requests.get(
        "https://messages.fredericks.app/messages",
        params={
            "after": int(after_date.timestamp() * 1000),
            "sender": sender,
        },
        headers={
            "X-API-Key": secrets.MESSAGES_API_KEY,
        },
    )
    data = response.json()
    message = Response.parse_obj(data)[0]
    if not message:
        logger.debug("No SMS/MMS messages found", message)
        raise Exception("No SMS/MMS messages found")
    code = re.search(TWO_FACTOR_AUTHENTICATION_CODE_REGEX, message.text)
    if not code:
        logger.error("2FA code not found", message)
        raise Exception("2FA code not found")
    logger.debug("Fetched 2FA code")
    return code.group(0)

@retry(tries=float('inf'), delay=1, timeout=60)
def get_email_two_factor_authentication_code(after_date, sender=None, subject=None):
    logger.debug("Fetching emails")
    account_id = jam.get_primary_account()
    email_query = jam.email_query(
        account_id=account_id,
        filter={
            "after": after_date.isoformat(),
            **({"from": sender} if sender else {}),
            **({"subject": subject} if subject else {}),
        },
        limit=1,
    )
    email = email_query[0]
    if not email:
        logger.debug("No emails found")
        raise Exception("No emails found")
    html_body = email.html_body[0]
    response = jam.download_blob(
        account_id=account_id,
        blob_id=html_body.blob_id,
        mime_type=html_body.type,
        file_name="",
    )
    html = response.text
    text = html2text(html)
    code = re.search(TWO_FACTOR_AUTHENTICATION_CODE_REGEX, text)
    if not code:
        logger.debug("2FA code not found" + text)
        raise Exception("2FA code not found")
    logger.debug("Fetched 2FA code")
    return code.group(0)
