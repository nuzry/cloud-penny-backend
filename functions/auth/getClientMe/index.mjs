// lambdas/getClientMe/index.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const TABLE  = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";

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

// Only echoes fields that actually exist on the tenant record.
// Optional fields (externalId, roleArn, lastVerifiedAt, lastFailureReason)
// are included only once they've been set by later steps in the flow.
const sanitiseTenant = (item) => {
  const data = {
    tenantId:         item.tenantId,
    email:            item.email,
    planTier:         item.planTier,
    connectionStatus: item.connectionStatus,
    createdAt:        item.createdAt,
    updatedAt:        item.updatedAt
  };

  if (item.awsAccountId)      data.awsAccountId      = item.awsAccountId;
  if (item.externalId)        data.externalId        = item.externalId;
  if (item.roleArn)           data.roleArn            = item.roleArn;
  if (item.lastVerifiedAt)    data.lastVerifiedAt     = item.lastVerifiedAt;
  if (item.lastFailureReason) data.lastFailureReason  = item.lastFailureReason;
  if (item.dailyRefreshQuota !== undefined) data.dailyRefreshQuota = item.dailyRefreshQuota;

  return data;
};

export const handler = async (event) => {
  console.log("EVENT_PRINT:", JSON.stringify(event, null, 2));

  const tenantId = extractTenantId(event);
  if (!tenantId) {
    console.warn("UNAUTHORIZED: No sub claim found in token");
    return response(401, { success: false, error: "Unauthorized — invalid or missing token" });
  }

  console.log("TENANT_ID:", tenantId);

  let item;
  try {
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key:       { tenantId }
    }));
    item = result.Item;
  } catch (err) {
    console.error("DYNAMODB_GET_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to retrieve client details — please try again" });
  }

  if (!item) {
    console.warn("NOT_FOUND: No tenant record for tenantId:", tenantId);
    return response(404, { success: false, error: "Client record not found" });
  }

  console.log("GET_CLIENT_SUCCESS:", tenantId);
  return response(200, { success: true, data: sanitiseTenant(item) });
};