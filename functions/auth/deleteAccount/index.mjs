// lambdas/deleteAccount/index.js
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, UpdateCommand, QueryCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetBucketPolicyCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const cognito = new CognitoIdentityProviderClient({});
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));

const TABLE          = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";
const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE ?? "cloudpenny-snapshots-dev";
const ALERTS_TABLE    = process.env.ALERTS_TABLE ?? "cloudpenny-alerts-dev";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Deletes every item in a (tenantId, sortKeyName) partition. Used to remove a
// tenant's full billing history and alert history when their account is
// deleted — previously nothing did this: the tenant row itself was removed,
// but every DAY#/MONTH# snapshot and every alert was left behind forever
// (no TTL on either table), an orphaned, unreachable, un-deletable copy of
// exactly the cost data a user asking to delete their account would expect
// to be gone too.
async function deleteAllForTenant(tableName, tenantId, sortKeyName) {
  let cursor;
  let deleted = 0;

  do {
    const res = await dynamo.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "tenantId = :t",
      ExpressionAttributeValues: { ":t": tenantId },
      ProjectionExpression: sortKeyName === "tenantId" ? "tenantId" : `tenantId, #sk`,
      ExpressionAttributeNames: sortKeyName === "tenantId" ? undefined : { "#sk": sortKeyName },
      ExclusiveStartKey: cursor,
    }));

    const items = res.Items || [];
    for (const batch of chunk(items, 25)) {
      if (batch.length === 0) continue;
      await dynamo.send(new BatchWriteCommand({
        RequestItems: {
          [tableName]: batch.map((item) => ({
            DeleteRequest: { Key: { tenantId: item.tenantId, [sortKeyName]: item[sortKeyName] } },
          })),
        },
      }));
      deleted += batch.length;
    }

    cursor = res.LastEvaluatedKey;
  } while (cursor);

  return deleted;
}

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

  // Step 1.5 — Delete the tenant's billing snapshots and cost-anomaly alerts.
  // Best-effort and non-blocking: Cognito access is already revoked at this
  // point, so a transient failure here must not trap the user unable to
  // delete their account. A failure is logged loudly for manual follow-up
  // rather than silently leaving the data behind (which is exactly the bug
  // this replaces).
  try {
    const snapshotsDeleted = await deleteAllForTenant(SNAPSHOTS_TABLE, tenantId, "snapshotId");
    const alertsDeleted = await deleteAllForTenant(ALERTS_TABLE, tenantId, "createdAt");
    console.log(`BILLING_DATA_CLEANED: tenant ${tenantId} — ${snapshotsDeleted} snapshot item(s), ${alertsDeleted} alert item(s) deleted.`);
  } catch (err) {
    console.error("BILLING_DATA_CLEANUP_FAILED — MANUAL INTERVENTION MAY BE REQUIRED:", {
      tenantId,
      error: err.message,
    });
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