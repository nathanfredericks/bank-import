import { PutObjectCommand, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import env from "./env.js";
import logger from "./logger.js";

const config: S3ClientConfig = {};
if (
  env.AWS_ACCESS_KEY_ID &&
  env.AWS_SECRET_ACCESS_KEY &&
  env.AWS_DEFAULT_REGION
) {
  config.region = env.AWS_DEFAULT_REGION;
  config.credentials = {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}
const s3Client = new S3Client(config);

async function uploadFile(key: string, contentType: string, body: any) {
  logger.debug(`Uploading file to S3 bucket: ${key}`);
  if (!env.AWS_S3_BUCKET_NAME) {
    throw new Error("No bucket name provided");
  }

  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Body: body,
    }),
  );
  logger.debug(`Uploaded file to S3 bucket: ${key}`);
}

export { uploadFile };
