// lambdas/getExternalId/index.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const TABLE  = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";

const now = () => new Date().toISOString();

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
  console.log("EVENT_PRINT:", JSON.stringify(event, null, 2));

  const tenantId = extractTenantId(event);
  if (!tenantId) {
    return response(401, { success: false, error: "Unauthorized — invalid or missing token" });
  }

  console.log("TENANT_ID:", tenantId);

  let item;
  try {
    const result = await dynamo.send(new GetCommand({
      TableName:            TABLE,
      Key:                  { tenantId },
      ProjectionExpression: "externalId"
    }));
    item = result.Item;
  } catch (err) {
    console.error("DYNAMODB_GET_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to retrieve record" });
  }

  if (!item) {
    return response(404, { success: false, error: "Client record not found" });
  }

  if (item.externalId) {
    console.log("EXTERNAL_ID_EXISTS:", tenantId);
    return response(200, { success: true, data: { externalId: item.externalId } });
  }

  // First-time hit — generate and persist atomically.
  // attribute_not_exists guard prevents a race condition if two requests
  // arrive simultaneously before either has written the value.
  const externalId = randomUUID();

  try {
    await dynamo.send(new UpdateCommand({
      TableName:                 TABLE,
      Key:                       { tenantId },
      UpdateExpression:          "SET externalId = :eid, updatedAt = :now",
      ConditionExpression:       "attribute_not_exists(externalId)",
      ExpressionAttributeValues: {
        ":eid": externalId,
        ":now": now()
      }
    }));

    console.log("EXTERNAL_ID_CREATED:", tenantId);
    return response(200, { success: true, data: { externalId } });

  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log("RACE_CONDITION_HIT — re-fetching externalId for:", tenantId);
      try {
        const retry = await dynamo.send(new GetCommand({
          TableName:            TABLE,
          Key:                  { tenantId },
          ProjectionExpression: "externalId"
        }));
        return response(200, { success: true, data: { externalId: retry.Item?.externalId } });
      } catch (retryErr) {
        console.error("RETRY_FETCH_ERROR:", retryErr.message);
        return response(500, { success: false, error: "Failed to resolve externalId after race" });
      }
    }

    console.error("DYNAMODB_UPDATE_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to generate externalId" });
  }
};