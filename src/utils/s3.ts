import {
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";
const s3 = new S3Client({
  region: Bun.env.AWS_REGION ?? Bun.env.AWS_DEFAULT_REGION,
});
export async function uploadFile(
  bucket: string,
  key: string,
  contentType: string,
  body: PutObjectCommandInput["Body"],
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      Body: body,
    }),
  );
}
