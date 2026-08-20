import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, CopyObjectCommand } from "@aws-sdk/client-s3";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const SOURCE_BUCKET = process.env.CENTRAL_CUR_BUCKET || "cloudpenny-central-curs-dev";
// We hardcode the template file path we know exists
const SOURCE_KEY = "344167512252/CloudPenny-096af58c-MSXUVMQJ/data/BILLING_PERIOD=2026-08/CloudPenny-096af58c-MSXUVMQJ-00001.snappy.parquet";

const extractTenantId = (event) =>
  event?.requestContext?.authorizer?.jwt?.claims?.sub ??
  event?.requestContext?.authorizer?.claims?.sub ??
  null;

export const handler = async (event) => {
  try {
    const tenantId = extractTenantId(event);
    if (!tenantId) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    // Fetch the client's awsAccountId
    const getRes = await dynamo.send(new GetCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId }
    }));

    if (!getRes.Item || !getRes.Item.awsAccountId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "No AWS account is connected for this tenant." })
      };
    }

    const awsAccountId = getRes.Item.awsAccountId;

    // To ensure a unique file drop that triggers SQS, we generate a random suffix
    const randomId = Math.random().toString(36).substring(2, 8);
    // MUST drop into the exact same folder the Glue crawler mapped to for this partition
    const destinationKey = `${awsAccountId}/CloudPenny-096af58c-MSXUVMQJ/data/BILLING_PERIOD=2026-08/sample-${randomId}.parquet`;

    console.log(`Copying template from ${SOURCE_KEY} to ${destinationKey}`);

    await s3.send(new CopyObjectCommand({
      CopySource: `${SOURCE_BUCKET}/${SOURCE_KEY}`,
      Bucket: SOURCE_BUCKET,
      Key: destinationKey
    }));

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: "Sample CUR data injected successfully! Orchestration pipeline has been triggered.",
        destinationKey
      })
    };
  } catch (error) {
    console.error("Error triggering sample CUR:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: "Internal server error", error: error.message })
    };
  }
};
