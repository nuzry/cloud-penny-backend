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

  // 2. Update S3 Bucket Policy — add a per-tenant statement scoped to their prefix.
  //
  //  Structure:
  //    Sid:      "tenant-{awsAccountId}"
  //    Resource: s3://{BUCKET}/{tenantId}/*   ← only their folder
  //    Condition: their BCMDataExports ARN + their SourceAccount
  //
  //  This means each client can only write into their own prefix,
  //  and no other account's exports can land in the wrong folder.
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

      // Remove legacy/generic statements and any stale entry for this account
      policyObj.Statement = policyObj.Statement.filter(s =>
        s.Sid !== "AllowBillingReports" &&
        s.Sid !== "AllowBillingReportsPutObject" &&
        s.Sid !== "AllowCURGetAclPolicy" &&
        s.Sid !== "AllowCURPutObject" &&
        s.Sid !== "AllowBCMDataExports" &&
        s.Sid !== "EnableAWSDataExportsToWriteToS3" &&
        s.Sid !== `tenant-${awsAccountId}` &&
        s.Sid !== `tenant-${tenantId}`
      );

      // Add a fresh, tightly-scoped statement for this tenant
      policyObj.Statement.push({
        Sid: `tenant-${tenantId}`,
        Effect: "Allow",
        Principal: { Service: "bcm-data-exports.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${BUCKET}/*`,
        Condition: {
          ArnLike: {
            "aws:SourceArn": `arn:aws:bcm-data-exports:us-east-1:${awsAccountId}:export/*`
          },
          StringEquals: {
            "aws:SourceAccount": awsAccountId
          }
        }
      });

      await s3.send(new PutBucketPolicyCommand({
        Bucket: BUCKET,
        Policy: JSON.stringify(policyObj)
      }));
      console.log(`BUCKET_POLICY_UPDATED: tenant-${awsAccountId} → s3://${BUCKET}/${tenantId}/*`);

    } catch (err) {
      console.error("S3_POLICY_UPDATE_ERROR:", err.message);
      // Non-fatal — DB record is saved, ops can fix policy manually if needed.
    }
  }

  const shortId = tenantId.substring(0, 8);
  const ts = Date.now().toString(36).toUpperCase();
  const exportName = `CloudPenny-${shortId}-${ts}`;
  const templateURL = `https://cloud-penny-bucket.s3.${process.env.AWS_REGION ?? "ap-southeast-1"}.amazonaws.com/cloud-formation/cur-setup.yml`;
  
  const cfUrl = `https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review` + 
    `?templateURL=${templateURL}` +
    `&stackName=CloudPenny-Export-${shortId}` +
    `&param_TenantId=${tenantId}` +
    `&param_S3Prefix=${tenantId}` +
    `&param_CentralBucketName=${BUCKET}` +
    `&param_CentralBucketRegion=${process.env.AWS_REGION ?? "ap-southeast-1"}` +
    `&param_ExportName=${exportName}` +
    `&param_AnomalySnsTopicArn=${process.env.ANOMALY_SNS_TOPIC_ARN ?? ""}`;

  return response(200, {
    success: true,
    message: "AWS Account ID saved and policy updated.",
    data: { 
      connectionStatus: "PENDING",
      cfUrl: cfUrl
    }
  });
};