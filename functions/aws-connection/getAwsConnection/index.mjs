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

export const handler = async (event) => {
  const tenantId = extractTenantId(event);
  if (!tenantId) {
    return response(401, { success: false, error: "Unauthorized" });
  }

  let item;
  try {
    const result = await dynamo.send(new GetCommand({
      TableName:            TABLE,
      Key:                  { tenantId },
      ProjectionExpression: "awsAccountId, connectionStatus"
    }));
    item = result.Item;
  } catch (err) {
    console.error("DYNAMODB_GET_ERROR:", err.message);
    return response(500, { success: false, error: "Failed to retrieve record" });
  }

  if (!item) {
    return response(404, { success: false, error: "Client record not found" });
  }

  const data = {
    awsAccountId: item.awsAccountId || null,
    connectionStatus: item.connectionStatus || "UNCONNECTED"
  };

  if (data.connectionStatus === "PENDING" && item.awsAccountId) {
    const shortId = tenantId.substring(0, 8);
    const ts = Date.now().toString(36).toUpperCase();
    const exportName = `CloudPenny-${shortId}-${ts}`;
    const BUCKET = process.env.CENTRAL_CURS_BUCKET || "cloudpenny-central-curs-dev";
    const templateURL = `https://cloud-penny-bucket.s3.${process.env.AWS_REGION ?? "ap-southeast-1"}.amazonaws.com/cloud-formation/cur-setup.yml`;
    
    data.cfUrl = `https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review` + 
      `?templateURL=${templateURL}` +
      `&stackName=CloudPenny-Export-${shortId}` +
      `&param_TenantId=${tenantId}` +
      `&param_S3Prefix=${item.awsAccountId}` +
      `&param_CentralBucketName=${BUCKET}` +
      `&param_CentralBucketRegion=${process.env.AWS_REGION ?? "ap-southeast-1"}` +
      `&param_ExportName=${exportName}`;
  }

  return response(200, {
    success: true,
    data
  });
};