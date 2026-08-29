// lambdas/deleteAccount/index.js
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetBucketPolicyCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const cognito = new CognitoIdentityProviderClient({});
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));

const TABLE       = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

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

// cognito:username is the actual Username Cognito needs for AdminDeleteUser.
// Falls back to sub, since many pools are configured with sub === username.
const extractUsername = (event) =>
  event?.requestContext?.authorizer?.jwt?.claims?.["cognito:username"] ??
  event?.requestContext?.authorizer?.claims?.["cognito:username"] ??
  extractTenantId(event);

export const handler = async (event) => {
  console.log("EVENT_PRINT:", JSON.stringify(event, null, 2));

  const tenantId = extractTenantId(event);
  const username  = extractUsername(event);

  if (!tenantId || !username) {
    console.warn("UNAUTHORIZED: No sub claim found in token");
    return response(401, { success: false, error: "Unauthorized — invalid or missing token" });
  }

  if (!USER_POOL_ID) {
    console.error("CONFIG_ERROR: COGNITO_USER_POOL_ID env var is not set");
    return response(500, { success: false, error: "Server misconfiguration — please contact support" });
  }

  console.log("TENANT_ID:", tenantId, "USERNAME:", username);

  const method = event.requestContext?.http?.method || event.httpMethod;

  if (method === "PUT") {
    // -------------------------------------------------------------
    // PUT: UPDATE CLIENT SETTINGS
    // -------------------------------------------------------------
    try {
      const body = JSON.parse(event.body || "{}");
      
      const updateExpressions = [];
      const expressionAttributeValues = {};
      const expressionAttributeNames = {};
      
      // Update Daily Refresh Quota
      if (body.dailyRefreshQuota !== undefined) {
        updateExpressions.push("#quota = :quota");
        expressionAttributeNames["#quota"] = "dailyRefreshQuota";
        expressionAttributeValues[":quota"] = Number(body.dailyRefreshQuota);
      }

      if (updateExpressions.length === 0) {
        return response(400, { success: false, error: "No valid fields provided for update" });
      }

      await dynamo.send(new UpdateCommand({
        TableName: TABLE,
        Key: { tenantId },
        UpdateExpression: "SET " + updateExpressions.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
      }));

      return response(200, { success: true, message: "Settings updated successfully" });
    } catch (err) {
      console.error("DYNAMODB_UPDATE_ERROR:", err);
      return response(500, { success: false, error: "Failed to update settings" });
    }
  }

  // -------------------------------------------------------------
  // DELETE: REMOVE CLIENT ACCOUNT
  // -------------------------------------------------------------
  // Step 0 - Fetch the user's AWS Account ID to clean up S3 Bucket Policy
  let awsAccountId = null;
  try {
    const res = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { tenantId } }));
    awsAccountId = res.Item?.awsAccountId;
  } catch (err) {
    console.warn("Failed to fetch tenant record for S3 cleanup:", err.message);
  }

  const bucket = process.env.CENTRAL_CURS_BUCKET;
  if (awsAccountId && bucket) {
    try {
      const policyData = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      const policyObj = JSON.parse(policyData.Policy);

      // Remove the per-tenant statement (Sid: "tenant-{awsAccountId}")
      const before = policyObj.Statement.length;
      policyObj.Statement = policyObj.Statement.filter(s => s.Sid !== `tenant-${awsAccountId}`);

      if (policyObj.Statement.length < before) {
        await s3.send(new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: JSON.stringify(policyObj)
        }));
        console.log(`BUCKET_POLICY_REVOKED: tenant-${awsAccountId}`);
      } else {
        console.log(`BUCKET_POLICY_NO_ENTRY_FOUND for tenant-${awsAccountId}`);
      }
    } catch (err) {
      console.warn("Failed to remove S3 bucket policy entry (moving on):", err.message);
    }
  }

  // Step 1 — Delete Cognito user first. This revokes login access
  // immediately, so even if the DynamoDB delete below fails, the
  // account is no longer usable and can be cleaned up safely later.
  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username:   username
    }));
    console.log("COGNITO_DELETE_SUCCESS:", tenantId);
  } catch (err) {
    if (err.name === "UserNotFoundException") {
      // Already deleted from Cognito — proceed to clean up the DynamoDB
      // record rather than blocking the user on a stale account.
      console.warn("COGNITO_USER_ALREADY_DELETED:", tenantId);
    } else {
      console.error("COGNITO_DELETE_ERROR:", err.name, err.message);
      return response(500, { success: false, error: "Failed to delete account — please try again" });
    }
  }

  // Step 2 — Delete the tenant record from DynamoDB.
  try {
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key:       { tenantId }
    }));
    console.log("DYNAMODB_DELETE_SUCCESS:", tenantId);
  } catch (err) {
    // Cognito user is already gone at this point, so the account is
    // inaccessible either way — but the orphaned record needs manual
    // cleanup since we can no longer retry via this tenant's own token.
    console.error("DYNAMODB_DELETE_FAILED — MANUAL INTERVENTION REQUIRED:", {
      tenantId,
      username,
      error: err.message
    });
    return response(500, {
      success: false,
      error: "Account access was removed, but cleanup is incomplete — please contact support"
    });
  }

  return response(200, {
    success: true,
    message: "Account deleted successfully"
  });
};