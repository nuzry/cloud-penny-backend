import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetBucketPolicyCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const TABLE  = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";
const BUCKET = process.env.CENTRAL_CURS_BUCKET;

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

  let awsAccountId;
  try {
    const body = JSON.parse(event.body ?? "{}");
    awsAccountId = body.awsAccountId?.trim();
  } catch {
    return response(400, { success: false, error: "Invalid request body" });
  }

  if (!awsAccountId || !/^\d{12}$/.test(awsAccountId)) {
    return response(400, { success: false, error: "A valid 12-digit AWS Account ID is required" });
  }

  // 1. Update DynamoDB
  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key:       { tenantId },
      UpdateExpression: `
        SET awsAccountId      = :awsAccountId,
            connectionStatus  = :status,
            updatedAt         = :now
        REMOVE roleArn, lastVerifiedAt, lastFailureReason
      `,
      ExpressionAttributeValues: {
        ":awsAccountId": awsAccountId,
        ":status":  "PENDING",
        ":now":     now()
      }
    }));
    console.log("ACCOUNT_SAVED: PENDING for", tenantId);
  } catch (err) {
    console.error("DYNAMODB_UPDATE_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to save account details" });
  }

  // 2. Update S3 Bucket Policy
  if (BUCKET) {
    try {
      let policyObj;
      try {
        const getPolicyRes = await s3.send(new GetBucketPolicyCommand({ Bucket: BUCKET }));
        policyObj = JSON.parse(getPolicyRes.Policy);
      } catch (err) {
        if (err.name === 'NoSuchBucketPolicy') {
          policyObj = { Version: "2012-10-17", Statement: [] };
        } else {
          throw err;
        }
      }

      const putObjSid = "AllowBillingReportsPutObject";
      let putStatement = policyObj.Statement.find(s => s.Sid === putObjSid);
      
      if (!putStatement) {
        putStatement = {
          Sid: putObjSid,
          Effect: "Allow",
          Principal: { Service: "bcm-data-exports.amazonaws.com" },
          Action: "s3:PutObject",
          Resource: `arn:aws:s3:::${BUCKET}/*`,
          Condition: {
            StringEquals: {
              "aws:SourceAccount": []
            }
          }
        };
        policyObj.Statement.push(putStatement);
      }

      // Ensure aws:SourceAccount exists
      if (!putStatement.Condition) putStatement.Condition = {};
      if (!putStatement.Condition.StringEquals) putStatement.Condition.StringEquals = {};
      
      let sourceAccounts = putStatement.Condition.StringEquals["aws:SourceAccount"] || [];
      if (!Array.isArray(sourceAccounts)) {
        sourceAccounts = [sourceAccounts];
      }

      if (!sourceAccounts.includes(awsAccountId)) {
        sourceAccounts.push(awsAccountId);
        putStatement.Condition.StringEquals["aws:SourceAccount"] = sourceAccounts;

        await s3.send(new PutBucketPolicyCommand({
          Bucket: BUCKET,
          Policy: JSON.stringify(policyObj)
        }));
        console.log("BUCKET_POLICY_UPDATED for account:", awsAccountId);
      } else {
        console.log("BUCKET_POLICY_UNCHANGED: account already whitelisted");
      }

    } catch (err) {
      console.error("S3_POLICY_UPDATE_ERROR:", err.message);
      // We don't fail the request here, but log it so ops can fix it.
      // The user still saved their account ID successfully in DB.
    }
  }

  return response(200, {
    success: true,
    message: "AWS Account ID saved and policy updated.",
    data: { connectionStatus: "PENDING" }
  });
};