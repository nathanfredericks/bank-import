import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { BankName } from "../banks/types";
import type { BankSession, Job } from "./types";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
export class SessionStore {
  readonly bank = process.env.BANK as BankName;
  readonly table = process.env.SESSION_TABLE!;
  readonly bucket = process.env.SESSION_BUCKET ?? process.env.EQ_STATE_BUCKET!;
  key(name: string) {
    return this.bank === BankName.EQBank ? name : `${this.bank}#${name}`;
  }
  jobKey(job: Pick<Job, "jobId">, file: string) {
    return this.bank === BankName.EQBank
      ? `jobs/${job.jobId}/${file}`
      : `jobs/${this.bank}/${job.jobId}/${file}`;
  }
  async read<T>(name: string): Promise<T | null> {
    const value = await db.send(
      new GetCommand({
        TableName: this.table,
        Key: { key: this.key(name) },
        ConsistentRead: true,
      }),
    );
    return value.Item?.data ? JSON.parse(value.Item.data) : null;
  }
  async object<T>(key: string): Promise<T | null> {
    try {
      const result = await s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return JSON.parse(await result.Body!.transformToString());
    } catch (error: any) {
      if (error.name === "NoSuchKey") return null;
      throw new Error("Private bank state read failed");
    }
  }
  async upload(key: string, value: unknown) {
    await s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      }),
    );
  }
  async acquire(owner: string) {
    const now = Math.floor(Date.now() / 1000);
    try {
      await db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { key: this.key("lease") },
          UpdateExpression: "SET #owner = :owner, expires = :expires",
          ConditionExpression:
            "attribute_not_exists(#owner) OR expires < :now OR #owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: {
            ":owner": owner,
            ":now": now,
            ":expires": now + 1800,
          },
        }),
      );
      return true;
    } catch (error: any) {
      if (error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
  async assertLease(owner: string) {
    const lease = await db.send(
      new GetCommand({
        TableName: this.table,
        Key: { key: this.key("lease") },
        ConsistentRead: true,
      }),
    );
    if (
      lease.Item?.owner !== owner ||
      lease.Item.expires <= Math.floor(Date.now() / 1000)
    )
      throw new Error("Bank session lease lost");
  }
  async put(name: string, value: unknown, owner: string) {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.table,
              Key: { key: this.key("lease") },
              ConditionExpression: "#owner = :owner AND expires > :now",
              ExpressionAttributeNames: { "#owner": "owner" },
              ExpressionAttributeValues: {
                ":owner": owner,
                ":now": Math.floor(Date.now() / 1000),
              },
            },
          },
          ...(process.env.BANK_REQUEST_ID
            ? [
                {
                  ConditionCheck: {
                    TableName: this.table,
                    Key: { key: this.key("active-request") },
                    ConditionExpression: "#data = :generation",
                    ExpressionAttributeNames: { "#data": "data" },
                    ExpressionAttributeValues: {
                      ":generation": JSON.stringify({
                        jobId: owner,
                        requestId: process.env.BANK_REQUEST_ID,
                      }),
                    },
                  },
                },
              ]
            : []),
          {
            Put: {
              TableName: this.table,
              Item: { key: this.key(name), data: JSON.stringify(value) },
            },
          },
        ],
      }),
    );
  }
  async release(owner: string) {
    try {
      await db.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { key: this.key("lease") },
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (error: any) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
  async session(): Promise<BankSession | null> {
    const pointer = await this.read<{ key: string }>("session-v2");
    if (!pointer) return null;
    const session = await this.object<BankSession>(pointer.key);
    if (!session || session.version !== 1 || session.bank !== this.bank)
      throw new Error("Invalid bank session identity");
    return session;
  }
  async saveSession(session: BankSession, owner: string) {
    // Immutable S3 objects + a lease-fenced pointer prevent expired workers from
    // replacing newer token rotations, even if their upload finishes late.
    await this.assertLease(owner);
    const key = `sessions/${this.bank}/${randomUUID()}.json`;
    await this.upload(key, session);
    await this.put("session-v2", { key }, owner);
  }
  async saveResult(job: Job, result: Record<string, unknown>) {
    await this.assertLease(job.jobId);
    const current = await this.object<Job>(this.jobKey(job, "job.json"));
    if (current?.requestId !== job.requestId)
      throw new Error("Stale bank request");
    await this.upload(this.jobKey(job, "result.json"), {
      version: 1,
      jobId: job.jobId,
      requestId: job.requestId,
      ...result,
    });
  }
}
