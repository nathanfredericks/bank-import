import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecs = new ECSClient({});
const tableName = process.env.AUTH_SESSIONS_TABLE_NAME;
const publicDirectory = path.join(process.cwd(), "public");
const bankNames = {
  bmo: "BMO",
  "rogers-bank": "Rogers Bank",
  nbdb: "NBDB",
  tangerine: "Tangerine",
};
const staticExtensions = new Set([".html", ".css", ".js", ".svg"]);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const json = (statusCode, body) => ({
  statusCode,
  headers: { "cache-control": "no-store", "content-type": "application/json" },
  body: JSON.stringify(body),
});
const cookies = (event) =>
  Object.fromEntries(
    (
      event.cookies?.join(";") ||
      event.headers?.cookie ||
      event.headers?.Cookie ||
      ""
    )
      .split(";")
      .map((value) => value.trim().split("=", 2))
      .filter(([name]) => name),
  );

async function getSession(id) {
  return (
    await dynamo.send(new GetCommand({ TableName: tableName, Key: { id } }))
  ).Item;
}

async function sessionByToken(token) {
  return (
    await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "tokenHash-index",
        KeyConditionExpression: "tokenHash = :tokenHash",
        ExpressionAttributeValues: { ":tokenHash": tokenHash(token) },
        Limit: 1,
      }),
    )
  ).Items?.[0];
}

async function update(id, fields) {
  const entries = Object.entries(fields).filter(
    ([, value]) => value !== undefined,
  );
  if (!entries.length) return;
  const names = {};
  const values = {};
  const assignments = entries.map(([key, value], index) => {
    names[`#field${index}`] = key;
    values[`:value${index}`] = value;
    return `#field${index} = :value${index}`;
  });
  await dynamo.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { id },
      UpdateExpression: `SET ${assignments.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

async function claimRecovery(session) {
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { id: session.id },
        ConditionExpression: "#stage IN (:timedOut, :failed, :cancelled)",
        UpdateExpression:
          "SET #stage = :starting, #error = :empty REMOVE #connectionId",
        ExpressionAttributeNames: {
          "#stage": "stage",
          "#error": "error",
          "#connectionId": "connectionId",
        },
        ExpressionAttributeValues: {
          ":timedOut": "timed_out",
          ":failed": "failed",
          ":cancelled": "cancelled",
          ":starting": "starting_recovery",
          ":empty": "",
        },
      }),
    );
    return true;
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

async function startRecovery(session) {
  if (!(await claimRecovery(session))) return false;
  const result = await ecs.send(
    new RunTaskCommand({
      cluster: process.env.AUTH_ECS_CLUSTER_ARN,
      taskDefinition: process.env.AUTH_WORKER_TASK_DEFINITION_ARN,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: process.env.AUTH_WORKER_SUBNET_IDS.split(","),
          securityGroups: process.env.AUTH_WORKER_SECURITY_GROUP_IDS.split(","),
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "bank-import",
            environment: [
              { name: "BANK", value: session.bank },
              { name: "AUTH_SESSION_ID", value: session.id },
            ],
          },
        ],
      },
    }),
  );
  const taskArn = result.tasks?.[0]?.taskArn;
  if (!taskArn) {
    await update(session.id, {
      stage: "failed",
      error: "Unable to start the reconnect worker",
    });
    throw new Error("Unable to start reconnect worker");
  }
  await update(session.id, {
    taskArn,
  });
  return true;
}

async function frontend(requestPath) {
  const relativePath =
    requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filename = path.resolve(publicDirectory, relativePath);
  if (!filename.startsWith(`${publicDirectory}${path.sep}`)) return;
  try {
    const body = await readFile(filename);
    const extension = path.extname(filename);
    return {
      statusCode: 200,
      isBase64Encoded: !staticExtensions.has(extension),
      headers: {
        "content-type":
          extension === ".html"
            ? "text/html; charset=utf-8"
            : contentTypes[extension] || "application/octet-stream",
        "cache-control":
          relativePath === "index.html"
            ? "no-store"
            : "public, max-age=31536000, immutable",
      },
      body: staticExtensions.has(extension)
        ? body.toString("utf8")
        : body.toString("base64"),
    };
  } catch {
    return;
  }
}

async function websocket(event) {
  const { routeKey, connectionId } = event.requestContext;
  const query = event.queryStringParameters || {};
  if (routeKey === "$connect") {
    const session = await getSession(query.sessionId);
    if (
      !session ||
      session.controlSecret !== query.secret ||
      session.expiresAt < Date.now()
    )
      return { statusCode: 401 };
    await update(session.id, { connectionId });
  }
  return { statusCode: 200 };
}

async function sendCommand(session, command, expectedStage) {
  if (session.stage !== expectedStage)
    return json(409, { error: "This verification step is no longer active" });
  if (!session.connectionId)
    return json(409, { error: "Worker is still preparing" });
  const endpoint = `https://${process.env.AUTH_WEBSOCKET_API_ID}.execute-api.${process.env.AWS_REGION}.amazonaws.com/${process.env.AUTH_WEBSOCKET_STAGE}`;
  try {
    await new ApiGatewayManagementApiClient({ endpoint }).send(
      new PostToConnectionCommand({
        ConnectionId: session.connectionId,
        Data: Buffer.from(JSON.stringify(command)),
      }),
    );
    return json(200, { stage: "submitted" });
  } catch {
    await update(session.id, {
      stage: "timed_out",
      error: "Reconnect worker is no longer available",
      connectionId: undefined,
    });
    return json(409, { error: "Worker is no longer available" });
  }
}

async function http(event) {
  const requestPath = event.rawPath;
  if (requestPath.startsWith("/connect/")) {
    const session = await sessionByToken(requestPath.split("/").at(-1));
    if (!session || session.expiresAt < Date.now())
      return { statusCode: 410, body: "Reconnect link expired" };
    if (["timed_out", "failed", "cancelled"].includes(session.stage))
      await startRecovery(session);
    else if (session.stage === "awaiting_connection")
      await update(session.id, { stage: "awaiting_method" });
    const csrf = randomBytes(24).toString("base64url");
    return {
      statusCode: 303,
      headers: { location: "/", "cache-control": "no-store" },
      cookies: [
        `mfa_session=${session.id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
        `mfa_csrf=${csrf}; Path=/; Secure; SameSite=Strict; Max-Age=86400`,
      ],
    };
  }
  if (!requestPath.startsWith("/api/"))
    return (
      (await frontend(requestPath)) || { statusCode: 404, body: "Not found" }
    );
  const auth = cookies(event);
  const session = auth.mfa_session && (await getSession(auth.mfa_session));
  if (!session || session.expiresAt < Date.now())
    return json(401, { error: "unauthorized" });
  if (
    event.requestContext.http.method !== "GET" &&
    event.headers?.["x-csrf"] !== auth.mfa_csrf
  )
    return json(403, { error: "invalid request" });
  if (requestPath === "/api/challenge")
    return json(200, {
      bank: bankNames[session.bank] || "Your Bank",
      stage: session.stage,
      options: session.options,
      error: session.error,
    });
  const body = event.body ? JSON.parse(event.body) : {};
  if (requestPath === "/api/method")
    return sendCommand(
      session,
      { type: "select", optionId: body.optionId },
      "awaiting_method",
    );
  if (requestPath === "/api/code" && /^\d{4,12}$/.test(body.code || ""))
    return sendCommand(
      session,
      { type: "code", code: body.code },
      "awaiting_code",
    );
  return json(400, { error: "invalid request" });
}

export const handler = async (event) =>
  event.requestContext?.http ? http(event) : websocket(event);
