// lambdas/saveAwsConnection/index.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

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
    console.warn("UNAUTHORIZED: No sub claim found in token");
    return response(401, { success: false, error: "Unauthorized — invalid or missing token" });
  }

  console.log("TENANT_ID:", tenantId);

  let roleArn;
  try {
    const body = JSON.parse(event.body ?? "{}");
    roleArn = body.roleArn?.trim();
  } catch {
    return response(400, { success: false, error: "Invalid request body" });
  }

  if (!roleArn) {
    return response(400, { success: false, error: "roleArn is required" });
  }

  if (!roleArn.startsWith("arn:aws:iam::")) {
    return response(400, { success: false, error: "Invalid Role ARN format — should start with arn:aws:iam::" });
  }

  // Save roleArn, flip status to PENDING, and clear any stale verify
  // results from a previous attempt — /verify is the only place that
  // sets VERIFIED, lastVerifiedAt, or lastFailureReason again.
  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key:       { tenantId },
      UpdateExpression: `
        SET roleArn           = :roleArn,
            connectionStatus  = :status,
            updatedAt         = :now
        REMOVE lastVerifiedAt, lastFailureReason
      `,
      ExpressionAttributeValues: {
        ":roleArn": roleArn,
        ":status":  "PENDING",
        ":now":     now()
      }
    }));

    console.log("ARN_SAVED: PENDING for", tenantId);
  } catch (err) {
    console.error("DYNAMODB_UPDATE_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to save connection details — please try again" });
  }

  return response(200, {
    success: true,
    message: "Role ARN saved — call /verify to confirm the connection",
    data: { connectionStatus: "PENDING" }
  });
};