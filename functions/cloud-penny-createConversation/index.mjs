import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const SUPPORT_TABLE = process.env.SUPPORT_TABLE ?? "cloudpenny-support-dev";
const TENANTS_TABLE = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";
const TELEGRAM_SECRET_NAME = process.env.TELEGRAM_SECRET_NAME;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_SUBJECT_LEN = 200;
const MAX_MESSAGE_LEN = 3500; // leaves headroom for the header text within Telegram's 4096-char sendMessage limit

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

// Cached in module scope so a warm container only calls Secrets Manager once.
let cachedSecret = null;
async function getTelegramSecret() {
  if (cachedSecret) return cachedSecret;
  const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: TELEGRAM_SECRET_NAME }));
  cachedSecret = JSON.parse(res.SecretString);
  return cachedSecret;
}

// Best-effort relay — a Telegram outage must never block a client from
// opening a conversation; the conversation is still saved either way and
// admins can still see it (once relay issues are fixed) via a future reply.
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

  let subject, message;
  try {
    const body = JSON.parse(event.body ?? "{}");
    subject = String(body.subject ?? "").trim();
    message = String(body.message ?? "").trim();
  } catch {
    return response(400, { success: false, error: "Invalid request body" });
  }

  if (!subject || subject.length > MAX_SUBJECT_LEN) {
    return response(400, { success: false, error: `Subject is required and must be ${MAX_SUBJECT_LEN} characters or fewer.` });
  }
  if (!message || message.length > MAX_MESSAGE_LEN) {
    return response(400, { success: false, error: `Message is required and must be ${MAX_MESSAGE_LEN} characters or fewer.` });
  }

  // Looked up once so admin replies in Telegram show who they're actually
  // talking to, instead of a bare tenant UUID.
  let tenantEmail = "Unknown";
  try {
    const { Item } = await dynamo.send(new GetCommand({ TableName: TENANTS_TABLE, Key: { tenantId } }));
    if (Item?.email) tenantEmail = Item.email;
  } catch (err) {
    console.warn("TENANT_LOOKUP_WARN:", err.message);
  }

  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();

  let telegramMessageId = null;
  try {
    const { botToken } = await getTelegramSecret();
    telegramMessageId = await sendTelegramMessage(
      botToken,
      TELEGRAM_CHAT_ID,
      `New support conversation\nFrom: ${tenantEmail}\nSubject: ${subject}\n\n${message}\n\n(Reply to this message to respond. Reply "/resolve" to close the conversation.)`
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

  const metaItem = {
    tenantId,
    sortKey: `CONVMETA#${conversationId}`,
    conversationId,
    subject,
    status: "OPEN",
    tenantEmail,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    lastMessagePreview: message.slice(0, 140),
    ...(telegramMessageId ? { lastTelegramMessageId: telegramMessageId } : {})
  };

  try {
    await dynamo.send(new PutCommand({ TableName: SUPPORT_TABLE, Item: metaItem }));
    await dynamo.send(new PutCommand({ TableName: SUPPORT_TABLE, Item: messageItem }));
  } catch (err) {
    console.error("DYNAMO_WRITE_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to create conversation" });
  }

  console.log(`CONVERSATION_CREATED: tenant=${tenantId} conversationId=${conversationId}`);
  return response(200, {
    success: true,
    data: { conversationId, subject, status: "OPEN", createdAt: now }
  });
};
