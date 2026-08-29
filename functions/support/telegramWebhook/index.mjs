import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const SUPPORT_TABLE = process.env.SUPPORT_TABLE ?? "cloudpenny-support-dev";
const TELEGRAM_SECRET_NAME = process.env.TELEGRAM_SECRET_NAME;

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
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error("TELEGRAM_SEND_EXCEPTION:", err.message);
  }
}

// This is the ONE route in the whole API with no Cognito authorizer in front
// of it (see infra/functions.json's "public": true + infra/main.tf) — it has
// to be reachable by Telegram directly. The secret-token header check below
// is therefore the ENTIRE access control for this endpoint, not a
// belt-and-suspenders extra. Always return 200 to Telegram (even on our own
// errors) so it doesn't hammer retries on a transient bug; every failure
// path is still fully logged to CloudWatch.
export const handler = async (event) => {
  console.log("TELEGRAM_WEBHOOK_EVENT:", JSON.stringify(event));

  try {
    const { botToken, webhookSecret } = await getTelegramSecret();

    const providedSecret =
      event.headers?.["x-telegram-bot-api-secret-token"] ??
      event.headers?.["X-Telegram-Bot-Api-Secret-Token"];

    if (!webhookSecret || providedSecret !== webhookSecret) {
      console.warn("TELEGRAM_WEBHOOK_UNAUTHORIZED: secret token missing or mismatched");
      return { statusCode: 401, body: "" };
    }

    let update;
    try {
      update = JSON.parse(event.body ?? "{}");
    } catch {
      console.warn("TELEGRAM_WEBHOOK: unparseable body");
      return { statusCode: 200, body: "" };
    }

    const message = update.message;

    // Not a reply to one of our messages — nothing to correlate it to.
    // Ordinary chatter in the group isn't an error, just not actionable.
    if (!message || !message.reply_to_message) {
      return { statusCode: 200, body: "" };
    }

    const repliedToId = message.reply_to_message.message_id;

    const { Items } = await dynamo.send(new QueryCommand({
      TableName: SUPPORT_TABLE,
      IndexName: "telegramMessageId-index",
      KeyConditionExpression: "telegramMessageId = :id",
      ExpressionAttributeValues: { ":id": repliedToId }
    }));

    if (!Items || Items.length === 0) {
      console.warn(`TELEGRAM_WEBHOOK: no conversation found for replied-to message ${repliedToId}`);
      return { statusCode: 200, body: "" };
    }

    const { tenantId, conversationId } = Items[0];
    const replyText = (message.text || "").trim();
    const now = new Date().toISOString();

    const { Item: meta } = await dynamo.send(new GetCommand({
      TableName: SUPPORT_TABLE,
      Key: { tenantId, sortKey: `CONVMETA#${conversationId}` }
    }));

    if (!meta) {
      console.warn(`TELEGRAM_WEBHOOK: conversation ${conversationId} metadata missing`);
      return { statusCode: 200, body: "" };
    }

    if (meta.status === "RESOLVED") {
      await sendTelegramMessage(
        botToken,
        message.chat.id,
        "This conversation is already resolved — the client won't see further replies here.",
        message.message_id
      );
      return { statusCode: 200, body: "" };
    }

    // Lets an admin close a ticket from Telegram without opening the app.
    if (replyText === "/resolve") {
      await dynamo.send(new UpdateCommand({
        TableName: SUPPORT_TABLE,
        Key: { tenantId, sortKey: `CONVMETA#${conversationId}` },
        UpdateExpression: "SET #status = :resolved, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":resolved": "RESOLVED", ":now": now }
      }));
      await sendTelegramMessage(botToken, message.chat.id, "Marked as resolved.", message.message_id);
      return { statusCode: 200, body: "" };
    }

    if (!replyText) {
      // e.g. a sticker/photo-only reply — nothing text-based to relay.
      return { statusCode: 200, body: "" };
    }

    const messageId = crypto.randomUUID();
    await dynamo.send(new PutCommand({
      TableName: SUPPORT_TABLE,
      Item: {
        tenantId,
        sortKey: `CONVMSG#${conversationId}#${now}#${messageId}`,
        conversationId,
        messageId,
        sender: "ADMIN",
        text: replyText,
        createdAt: now,
        telegramMessageId: message.message_id
      }
    }));

    await dynamo.send(new UpdateCommand({
      TableName: SUPPORT_TABLE,
      Key: { tenantId, sortKey: `CONVMETA#${conversationId}` },
      UpdateExpression: "SET updatedAt = :now, lastMessageAt = :now, lastMessagePreview = :preview, lastTelegramMessageId = :tgid",
      ExpressionAttributeValues: {
        ":now": now,
        ":preview": replyText.slice(0, 140),
        ":tgid": message.message_id
      }
    }));

    console.log(`TELEGRAM_WEBHOOK_RELAYED: tenant=${tenantId} conversationId=${conversationId}`);
    return { statusCode: 200, body: "" };
  } catch (err) {
    console.error("TELEGRAM_WEBHOOK_ERROR:", err);
    return { statusCode: 200, body: "" };
  }
};
