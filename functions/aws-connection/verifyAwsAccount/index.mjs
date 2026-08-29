import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const TABLE  = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";
const BUCKET = process.env.CENTRAL_CURS_BUCKET;

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

  let awsAccountId;
  try {
    const res = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { tenantId } }));
    awsAccountId = res.Item?.awsAccountId;
  } catch (err) {
    console.error("DYNAMO_ERROR", err);
    return response(500, { success: false, error: "Internal Error" });
  }

  if (!awsAccountId) {
    return response(400, { success: false, error: "No AWS Account ID configured." });
  }

  // Check if we have received any files for this tenant
  let filesReceived = false;

  try {
    if (BUCKET) {
      const shortId = tenantId.substring(0, 8);
      const listRes = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `${tenantId}/CloudPenny-${shortId}-`,
        MaxKeys: 1
      }));
      filesReceived = listRes.KeyCount > 0;
    }
  } catch (err) {
    console.error("S3_LIST_ERROR", err);
    // Ignore error, just means we can't verify yet
  }

  if (filesReceived) {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: TABLE,
        Key: { tenantId },
        UpdateExpression: "SET connectionStatus = :status, lastVerifiedAt = :now",
        ExpressionAttributeValues: {
          ":status": "VERIFIED",
          ":now": new Date().toISOString()
        }
      }));
    } catch (err) {
      console.error("DYNAMO_UPDATE_ERROR", err);
    }

    return response(200, {
      success: true,
      data: { connectionStatus: "VERIFIED" }
    });
  }

  return response(200, {
    success: false,
    error: "No CUR files received yet. Please wait up to 24 hours.",
    data: { connectionStatus: "PENDING" }
  });
};
