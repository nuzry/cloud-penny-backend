import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const SUPPORT_TABLE = process.env.SUPPORT_TABLE ?? "cloudpenny-support-dev";
const TELEGRAM_SECRET_NAME = process.env.TELEGRAM_SECRET_NAME;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*"
  },
  body: JSON.stringify(body)
});

const extractTenantId = (event) =>
  event?.requestContext?.authorizer?.jwt?.claims?.sub ??
  event?.requestContext?.authorizer?.claims?.sub ??
  null;

let cachedSecret = null;
async function getTelegramSecret() {
  if (cachedSecret) return cachedSecret;
  const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: TELEGRAM_SECRET_NAME }));
  cachedSecret = JSON.parse(res.SecretString);
  return cachedSecret;
}

// Best-effort — resolving in the app must succeed even if this notification fails.
async function notifyTelegramResolved(botToken, chatId, replyToMessageId) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "The client marked this conversation as resolved.",
        reply_to_message_id: replyToMessageId
      })
    });
  } catch (err) {
    console.error("TELEGRAM_NOTIFY_EXCEPTION:", err.message);
  }
}

export const handler = async (event) => {
  const tenantId = extractTenantId(event);
  if (!tenantId) {
    return response(401, { success: false, error: "Unauthorized" });
  }

  const conversationId = event.pathParameters?.conversationId;
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return response(400, { success: false, error: "Invalid conversation ID" });
  }

  const key = { tenantId, sortKey: `CONVMETA#${conversationId}` };

  let meta;
  try {
    const { Item } = await dynamo.send(new GetCommand({ TableName: SUPPORT_TABLE, Key: key }));
    meta = Item;
  } catch (err) {
    console.error("DYNAMODB_GET_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to load conversation" });
  }

  if (!meta) {
    return response(404, { success: false, error: "Conversation not found" });
  }

  // Already resolved — idempotent success rather than an error, since the
  // frontend may call this after the UI already reflects resolved state.
  if (meta.status === "RESOLVED") {
    return response(200, { success: true, data: { conversationId, status: "RESOLVED" } });
  }

  const now = new Date().toISOString();
  try {
    await dynamo.send(new UpdateCommand({
      TableName: SUPPORT_TABLE,
      Key: key,
      UpdateExpression: "SET #status = :resolved, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":resolved": "RESOLVED", ":now": now }
    }));
  } catch (err) {
    console.error("DYNAMODB_UPDATE_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to resolve conversation" });
  }

  if (meta.lastTelegramMessageId) {
    try {
      const { botToken } = await getTelegramSecret();
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) await notifyTelegramResolved(botToken, chatId, meta.lastTelegramMessageId);
    } catch (err) {
      console.error("TELEGRAM_SECRET_ERROR:", err.message);
    }
  }

  return response(200, { success: true, data: { conversationId, status: "RESOLVED", updatedAt: now } });
};
