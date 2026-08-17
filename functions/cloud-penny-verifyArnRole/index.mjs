// lambdas/verifyAwsConnection/index.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { AthenaClient, ListWorkGroupsCommand } from "@aws-sdk/client-athena";
import { GlueClient, GetDatabasesCommand } from "@aws-sdk/client-glue";

const REGION = process.env.AWS_REGION ?? "ap-southeast-1";
const TABLE  = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sts    = new STSClient({ region: REGION });

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

const resolveErrorMessage = (err) => {
  const code = err.name ?? err.Code ?? "";

  if (code === "AccessDenied") {
    return { reason: "ACCESS_DENIED", message: "Access denied — the role's trust policy is incorrect or the External ID doesn't match. Redeploy the CloudFormation stack and try again." };
  }
  if (code === "NoSuchEntity" || code === "NoSuchRole") {
    return { reason: "ROLE_NOT_FOUND", message: "Role not found — the Role ARN you provided doesn't exist in your AWS account. Check the ARN from the CloudFormation Outputs tab." };
  }
  if (code === "InvalidClientTokenId") {
    return { reason: "INVALID_ACCOUNT", message: "Invalid AWS account — the account ID in the Role ARN doesn't exist or is unreachable." };
  }
  if (code === "MalformedPolicyDocument") {
    return { reason: "MALFORMED_ROLE", message: "The role's trust policy is malformed. Redeploy the CloudFormation stack." };
  }
  return { reason: "UNKNOWN_ERROR", message: `Verification failed: ${err.message}` };
};

const verifyPermissions = async (credentials, region, accountId) => {
  const clientConfig = {
    region,
    credentials: {
      accessKeyId:     credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken:    credentials.SessionToken
    }
  };

  const checks = [];
  
  // The buckets are created with these predictable names in the CloudFormation stack
  const curBucketName = `cur-report-${accountId}`;
  const athenaBucketName = `cur-athena-results-${accountId}`;

  const checkS3Bucket = async (bucketName) => {
    try {
      await new S3Client(clientConfig).send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }));
      return true;
    } catch (err) {
      if (err.name === "PermanentRedirect" || err.$metadata?.httpStatusCode === 301) {
        const correctRegion = err.$response?.headers?.["x-amz-bucket-region"] || "us-east-1";
        console.log(`Bucket ${bucketName} is in ${correctRegion}. Retrying...`);
        
        const regionalConfig = { ...clientConfig, region: correctRegion };
        await new S3Client(regionalConfig).send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }));
        return true;
      }
      throw err;
    }
  };

  try {
    await checkS3Bucket(curBucketName);
    checks.push({ service: "s3-cur-bucket", accessible: true });
  } catch (err) {
    console.error("S3_CUR_CHECK_FAILED:", err.name, err.message);
    checks.push({ service: "s3-cur-bucket", accessible: false, reason: err.message });
  }

  try {
    await checkS3Bucket(athenaBucketName);
    checks.push({ service: "s3-athena-bucket", accessible: true });
  } catch (err) {
    console.error("S3_ATHENA_CHECK_FAILED:", err.name, err.message);
    checks.push({ service: "s3-athena-bucket", accessible: false, reason: err.message });
  }

  try {
    await new AthenaClient(clientConfig).send(new ListWorkGroupsCommand({}));
    checks.push({ service: "athena", accessible: true });
  } catch (err) {
    console.error("ATHENA_CHECK_FAILED:", err.name, err.message);
    checks.push({ service: "athena", accessible: false, reason: err.message });
  }

  try {
    await new GlueClient(clientConfig).send(new GetDatabasesCommand({}));
    checks.push({ service: "glue", accessible: true });
  } catch (err) {
    console.error("GLUE_CHECK_FAILED:", err.name, err.message);
    checks.push({ service: "glue", accessible: false, reason: err.message });
  }

  return checks;
};

const updateConnectionStatus = async (tenantId, status, failureReason = null) => {
  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key:       { tenantId },
      UpdateExpression: `
        SET connectionStatus  = :status,
            lastFailureReason = :reason,
            updatedAt         = :now
      `,
      ExpressionAttributeValues: {
        ":status": status,
        ":reason": failureReason,
        ":now":    now()
      }
    }));
    console.log(`CONNECTION_STATUS_UPDATED: ${status} for ${tenantId}`);
  } catch (err) {
    console.error("FAILED_TO_UPDATE_CONNECTION_STATUS:", err.message);
  }
};

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

  const awsAccountId = roleArn.split(':')[4];
  if (!awsAccountId || awsAccountId.length !== 12) {
    return response(400, { success: false, error: "Invalid Role ARN format — missing or invalid account ID" });
  }

  // Fetch tenant record — only need externalId
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
    return response(500, { success: false, error: "Failed to retrieve account details — please try again" });
  }

  if (!item) {
    return response(404, { success: false, error: "Client record not found" });
  }

  const externalId = item.externalId;
  if (!externalId) {
    console.error("MISSING_EXTERNAL_ID for tenantId:", tenantId);
    return response(500, { success: false, error: "Account setup incomplete — please contact support" });
  }

  // Attempt STS AssumeRole with submitted ARN + stored externalId
  let assumedCredentials;
  try {
    console.log("STS_ASSUME_ROLE_ATTEMPT:", roleArn);

    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn:         roleArn,
      RoleSessionName: `cloudpenny-verify-${tenantId.slice(0, 16)}`,
      ExternalId:      externalId,
      DurationSeconds: 900
    }));

    assumedCredentials = assumed.Credentials;
    console.log("STS_ASSUME_ROLE_SUCCESS");
  } catch (err) {
    console.error("STS_ASSUME_ROLE_FAILED:", err.name, err.message);

    const { reason, message } = resolveErrorMessage(err);
    await updateConnectionStatus(tenantId, "FAILED", message);

    return response(403, { success: false, reason, error: message });
  }

  // Verify actual permissions inside the customer's account using the extracted accountId
  const checks = await verifyPermissions(assumedCredentials, REGION, awsAccountId);
  const failed  = checks.filter(c => !c.accessible);

  console.log("PERMISSION_CHECKS:", JSON.stringify(checks));

  if (failed.length > 0) {
    const message = `Role assumed but missing access to: ${failed.map(f => f.service).join(", ")}. Redeploy the CloudFormation stack and try again.`;
    await updateConnectionStatus(tenantId, "FAILED", message);

    return response(403, { success: false, reason: "INSUFFICIENT_PERMISSIONS", error: message, checks });
  }

  // All checks passed — save verified ARN + status, clear any prior failure reason
  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key:       { tenantId },
      UpdateExpression: `
        SET roleArn          = :roleArn,
            connectionStatus = :status,
            lastVerifiedAt   = :verifiedAt,
            updatedAt        = :now
        REMOVE lastFailureReason
      `,
      ExpressionAttributeValues: {
        ":roleArn":    roleArn,
        ":status":     "VERIFIED",
        ":verifiedAt": now(),
        ":now":        now()
      }
    }));

    console.log("VERIFY_STATUS_UPDATED: VERIFIED for", tenantId);
  } catch (err) {
    console.error("DYNAMODB_UPDATE_ERROR:", err.message);
    return response(500, { success: false, error: "Verification succeeded but failed to save status — please retry" });
  }

  return response(200, {
    success: true,
    message: "AWS account connected successfully",
    data: {
      connectionStatus: "VERIFIED",
      verifiedAt:       now(),
      checks
    }
  });
};
