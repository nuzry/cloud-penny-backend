import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const SUPPORT_TABLE = process.env.SUPPORT_TABLE ?? "cloudpenny-support-dev";
const TELEGRAM_SECRET_NAME = process.env.TELEGRAM_SECRET_NAME;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_MESSAGE_LEN = 3800;
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

async function sendTelegramMessage(botToken, chatId, text, replyToMessageId) {
  try {
    const body = { chat_id: chatId, text };
    if (replyToMessageId) body.reply_to_message_id = replyToMessageId;

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("TELEGRAM_SEND_ERROR:", JSON.stringify(data));
      return null;
    }
    return data.result.message_id;
  } catch (err) {
    console.error("TELEGRAM_SEND_EXCEPTION:", err.message);
    return null;
  }
}

export const handler = async (event) => {
  console.log("EVENT_PRINT:", JSON.stringify(event, null, 2));

  const tenantId = extractTenantId(event);
  if (!tenantId) {
    return response(401, { success: false, error: "Unauthorized" });
  }

  const conversationId = event.pathParameters?.conversationId;
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return response(400, { success: false, error: "Invalid conversation ID" });
  }

  let message;
  try {
    const body = JSON.parse(event.body ?? "{}");
    message = String(body.message ?? "").trim();
  } catch {
    return response(400, { success: false, error: "Invalid request body" });
  }

  if (!message || message.length > MAX_MESSAGE_LEN) {
    return response(400, { success: false, error: `Message is required and must be ${MAX_MESSAGE_LEN} characters or fewer.` });
  }

  // Scoped to this tenant's own partition — a tenant can never reach another
  // tenant's conversation regardless of what conversationId they pass in.
  const { Item: meta } = await dynamo.send(new GetCommand({
    TableName: SUPPORT_TABLE,
    Key: { tenantId, sortKey: `CONVMETA#${conversationId}` }
  }));

  if (!meta) {
    return response(404, { success: false, error: "Conversation not found" });
  }
  if (meta.status === "RESOLVED") {
    return response(409, { success: false, error: "This conversation is resolved and can no longer accept new messages." });
  }

  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();

  let telegramMessageId = null;
  try {
    const { botToken } = await getTelegramSecret();
    telegramMessageId = await sendTelegramMessage(
      botToken,
      TELEGRAM_CHAT_ID,
      message,
      meta.lastTelegramMessageId
    );
  } catch (err) {
    console.error("TELEGRAM_RELAY_ERROR:", err.message);
  }

  const messageItem = {
    tenantId,
    sortKey: `CONVMSG#${conversationId}#${now}#${messageId}`,
    conversationId,
    messageId,
    sender: "CLIENT",
    text: message,
    createdAt: now,
    ...(telegramMessageId ? { telegramMessageId } : {})
  };

  try {
    await dynamo.send(new PutCommand({ TableName: SUPPORT_TABLE, Item: messageItem }));

    await dynamo.send(new UpdateCommand({
      TableName: SUPPORT_TABLE,
      Key: { tenantId, sortKey: `CONVMETA#${conversationId}` },
      UpdateExpression: `
        SET updatedAt = :now,
            lastMessageAt = :now,
            lastMessagePreview = :preview
            ${telegramMessageId ? ", lastTelegramMessageId = :tgid" : ""}
      `,
      ExpressionAttributeValues: {
        ":now": now,
        ":preview": message.slice(0, 140),
        ...(telegramMessageId ? { ":tgid": telegramMessageId } : {})
      }
    }));
  } catch (err) {
    console.error("DYNAMO_WRITE_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to send message" });
  }

  return response(200, { success: true, data: { messageId, createdAt: now } });
};
