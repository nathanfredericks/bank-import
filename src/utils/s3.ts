import {
  GetObjectCommand,
  PutObjectCommand,
  PutObjectCommandInput,
  S3Client,
  S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import env from "./env";
import logger from "./logger";

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

async function uploadFile(
  bucket: string,
  key?: string,
  contentType?: string,
  body?: PutObjectCommandInput["Body"],
) {
  logger.debug(`Uploading file to S3 bucket: ${key}`);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      Body: body,
    }),
  );
  logger.debug(`Uploaded file to S3 bucket: ${key}`);
}

async function downloadFile(
  bucket: string,
  key: string,
  path: string,
): Promise<void> {
  logger.debug(`Downloading file from S3 bucket: ${key}`);
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  if (!response.Body) {
    throw new Error("No body in S3 response");
  }
  const fileStream = createWriteStream(path);
  await pipeline(response.Body as Readable, fileStream);
  logger.debug(`Successfully downloaded file from S3 bucket: ${key}`);
}

export { downloadFile, uploadFile };
