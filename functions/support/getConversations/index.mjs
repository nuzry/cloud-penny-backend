import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const SUPPORT_TABLE = process.env.SUPPORT_TABLE ?? "cloudpenny-support-dev";

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

  let items;
  try {
    const { Items } = await dynamo.send(new QueryCommand({
      TableName: SUPPORT_TABLE,
      KeyConditionExpression: "tenantId = :t AND begins_with(sortKey, :prefix)",
      ExpressionAttributeValues: {
        ":t": tenantId,
        ":prefix": "CONVMETA#"
      }
    }));
    items = Items || [];
  } catch (err) {
    console.error("DYNAMODB_QUERY_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to list conversations" });
  }

  const conversations = items
    .map(item => ({
      conversationId: item.conversationId,
      subject: item.subject,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lastMessageAt: item.lastMessageAt,
      lastMessagePreview: item.lastMessagePreview
    }))
    .sort((a, b) => (b.lastMessageAt || "").localeCompare(a.lastMessageAt || ""));

  return response(200, { success: true, data: conversations });
};
