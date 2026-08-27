import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const SUPPORT_TABLE = process.env.SUPPORT_TABLE ?? "cloudpenny-support-dev";

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

export const handler = async (event) => {
  const tenantId = extractTenantId(event);
  if (!tenantId) {
    return response(401, { success: false, error: "Unauthorized" });
  }

  const conversationId = event.pathParameters?.conversationId;
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return response(400, { success: false, error: "Invalid conversation ID" });
  }

  let meta, messageItems;
  try {
    // Scoped to this tenant's own partition — a tenant can never read another
    // tenant's conversation regardless of what conversationId they pass in.
    const [metaRes, messagesRes] = await Promise.all([
      dynamo.send(new GetCommand({
        TableName: SUPPORT_TABLE,
        Key: { tenantId, sortKey: `CONVMETA#${conversationId}` }
      })),
      dynamo.send(new QueryCommand({
        TableName: SUPPORT_TABLE,
        KeyConditionExpression: "tenantId = :t AND begins_with(sortKey, :prefix)",
        ExpressionAttributeValues: {
          ":t": tenantId,
          ":prefix": `CONVMSG#${conversationId}#`
        }
      }))
    ]);
    meta = metaRes.Item;
    messageItems = messagesRes.Items || [];
  } catch (err) {
    console.error("DYNAMODB_READ_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to load conversation" });
  }

  if (!meta) {
    return response(404, { success: false, error: "Conversation not found" });
  }

  // Sort keys embed an ISO timestamp (CONVMSG#<id>#<isoTimestamp>#<msgId>),
  // so lexical order from the Query is already chronological — no extra sort needed.
  const messages = messageItems.map(item => ({
    messageId: item.messageId,
    sender: item.sender,
    text: item.text,
    createdAt: item.createdAt
  }));

  return response(200, {
    success: true,
    data: {
      conversationId,
      subject: meta.subject,
      status: meta.status,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messages
    }
  });
};
