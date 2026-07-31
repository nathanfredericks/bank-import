import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BankName } from "../banks/types";
import { AuthSession, MfaStage } from "./types";

const tableName = Bun.env.AUTH_SESSIONS_TABLE_NAME;

const config: DynamoDBClientConfig = {};
if (
  Bun.env.AWS_ACCESS_KEY_ID &&
  Bun.env.AWS_SECRET_ACCESS_KEY &&
  Bun.env.AWS_DEFAULT_REGION
) {
  config.region = Bun.env.AWS_DEFAULT_REGION;
  config.credentials = {
    accessKeyId: Bun.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: Bun.env.AWS_SECRET_ACCESS_KEY,
  };
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient(config));

function requireTableName() {
  if (!tableName) {
    throw new Error("AUTH_SESSIONS_TABLE_NAME is required for MFA handoff");
  }
  return tableName;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newSecret() {
  return randomBytes(32).toString("base64url");
}

async function createSession(bank: BankName) {
  const token = newSecret();
  const controlSecret = newSecret();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const session: AuthSession = {
    id: randomUUID(),
    bank,
    tokenHash: hashToken(token),
    controlSecret,
    stage: "awaiting_connection",
    createdAt: now.toISOString(),
    expiresAt: expiresAt.getTime(),
    ttl: Math.floor(expiresAt.getTime() / 1000),
  };
  await client.send(
    new PutCommand({ TableName: requireTableName(), Item: session }),
  );
  return { session, token };
}

async function getSession(id: string) {
  const response = await client.send(
    new GetCommand({ TableName: requireTableName(), Key: { id } }),
  );
  return response.Item as AuthSession | undefined;
}

async function getSessionByToken(token: string) {
  const response = await client.send(
    new QueryCommand({
      TableName: requireTableName(),
      IndexName: "tokenHash-index",
      KeyConditionExpression: "tokenHash = :tokenHash",
      ExpressionAttributeValues: { ":tokenHash": hashToken(token) },
      Limit: 1,
    }),
  );
  return response.Items?.[0] as AuthSession | undefined;
}

async function updateSession(
  id: string,
  changes: Partial<
    Pick<
      AuthSession,
      "stage" | "taskArn" | "error" | "options" | "connectionId"
    >
  >,
) {
  const entries = Object.entries(changes).filter(
    ([, value]) => value !== undefined,
  );
  if (!entries.length) return;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const assignments = entries.map(([key, value], index) => {
    const name = `#field${index}`;
    const valueName = `:value${index}`;
    names[name] = key;
    values[valueName] = value;
    return `${name} = ${valueName}`;
  });
  await client.send(
    new UpdateCommand({
      TableName: requireTableName(),
      Key: { id },
      UpdateExpression: `SET ${assignments.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

async function setStage(id: string, stage: MfaStage, error?: string) {
  await updateSession(id, { stage, error });
}

export {
  createSession,
  getSession,
  getSessionByToken,
  hashToken,
  setStage,
  updateSession,
};
