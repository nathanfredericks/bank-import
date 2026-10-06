import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import env from "../../utils/env";

const client = new S3Client({
  region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
});
export async function readState(key: string): Promise<unknown | null> {
  try {
    const result = await client.send(
      new GetObjectCommand({ Bucket: env.EQ_STATE_BUCKET!, Key: key }),
    );
    return JSON.parse(await result.Body!.transformToString());
  } catch (error: any) {
    if (error.name === "NoSuchKey") return null;
    throw new Error("EQ private state could not be read");
  }
}
export async function writeState(key: string, value: unknown) {
  await client.send(
    new PutObjectCommand({
      Bucket: env.EQ_STATE_BUCKET!,
      Key: key,
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      Body: JSON.stringify(value),
    }),
  );
}
