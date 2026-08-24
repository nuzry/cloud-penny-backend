import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const TABLE = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";
const BUCKET = process.env.ATHENA_RESULTS_BUCKET ?? "cloud-penny-athena-results-dev";
const EXPIRY_DAYS = 7;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
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

  // Verify tenant exists and is connected
  let tenant;
  try {
    const res = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { tenantId } }));
    tenant = res.Item;
  } catch (err) {
    console.error("DynamoDB error:", err);
    return response(500, { success: false, error: "Failed to verify tenant" });
  }

  if (!tenant) {
    return response(404, { success: false, error: "Tenant not found" });
  }

  // List CSV files under this tenant's prefix in the Athena results bucket
  // Files are stored as: {tenantId}/{queryExecutionId}.csv
  const prefix = `${tenantId}/`;

  let objects;
  try {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
    }));
    objects = listRes.Contents || [];
  } catch (err) {
    console.error("S3 list error:", err);
    return response(500, { success: false, error: "Failed to list export files" });
  }

  // Filter to only .csv files (skip .metadata files)
  const csvFiles = objects.filter(obj => obj.Key.endsWith(".csv"));

  if (csvFiles.length === 0) {
    return response(200, { success: true, data: [] });
  }

  // For each CSV, generate a pre-signed download URL (valid for 1 hour)
  // and compute the expiry date (LastModified + 7 days)
  const files = await Promise.all(csvFiles.map(async (obj) => {
    const createdAt = obj.LastModified;
    const expiresAt = new Date(createdAt);
    expiresAt.setDate(expiresAt.getDate() + EXPIRY_DAYS);

    // Generate a pre-signed URL so the frontend can download directly
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: obj.Key,
        ResponseContentDisposition: `attachment; filename="${obj.Key.split("/").pop()}"`,
      }),
      { expiresIn: 3600 } // 1 hour
    );

    // Extract the query execution ID from the key
    const filename = obj.Key.split("/").pop(); // e.g. "a96fa369-1902-4bc0-a7ba-6d31da456ad7.csv"
    const queryId = filename.replace(".csv", "");

    return {
      key: obj.Key,
      filename,
      queryId,
      sizeBytes: obj.Size,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      downloadUrl: signedUrl,
    };
  }));

  // Sort by most recent first
  files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return response(200, { success: true, data: files });
};
