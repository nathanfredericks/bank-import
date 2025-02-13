import boto3
import logging
from botocore.exceptions import NoCredentialsError
from .env import env

logger = logging.getLogger(__name__)

s3_client = boto3.client(
    's3',
    aws_access_key_id=env.AWS_ACCESS_KEY_ID,
    aws_secret_access_key=env.AWS_SECRET_ACCESS_KEY,
    region_name=env.AWS_DEFAULT_REGION
)

def upload_file(key: str, content_type: str, body: bytes):
    logger.debug(f"Uploading file to S3 bucket: {key}")
    if not env.AWS_S3_BUCKET_NAME:
        raise ValueError("No bucket name provided")

    try:
        s3_client.put_object(
            Bucket=env.AWS_S3_BUCKET_NAME,
            Key=key,
            ContentType=content_type,
            Body=body
        )
        logger.debug(f"Uploaded file to S3 bucket: {key}")
    except NoCredentialsError:
        logger.error("Credentials not available")
        raise
