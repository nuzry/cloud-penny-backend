import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "cloudpenny-snapshots-dev";
const env = process.env.ENVIRONMENT || "dev";
const SNAPSHOTS_BUCKET = process.env.SNAPSHOTS_BUCKET || `cloudpenny-snapshot-data-${env}`;

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

    // Determine current month in YYYY-MM format
    const now = new Date();
    const currentMonthStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    console.log(`Fetching dashboard data for tenant ${tenantId}, month ${currentMonthStr}`);

    // 1. Try to fetch the detailed JSON file from S3 first (new architecture)
    try {
      const s3Key = `${tenantId}/dashboard-MONTH#${currentMonthStr}.json`;
      console.log(`[S3] Attempting to fetch detailed dashboard data from s3://${SNAPSHOTS_BUCKET}/${s3Key}`);
      
      const s3Res = await s3.send(new GetObjectCommand({
        Bucket: SNAPSHOTS_BUCKET,
        Key: s3Key
      }));
      
      // Convert stream to string
      const streamToString = (stream) =>
        new Promise((resolve, reject) => {
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });

      const bodyContents = await streamToString(s3Res.Body);
      const parsedData = JSON.parse(bodyContents);
      
      console.log(`[S3] Successfully fetched and parsed detailed dashboard data.`);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedData)
      };
    } catch (s3Err) {
      if (s3Err.name === 'NoSuchKey' || s3Err.name === 'NotFound') {
        console.log(`[S3] No detailed S3 JSON found for this month (fallback to DynamoDB).`);
      } else {
        console.warn(`[S3 WARN] Failed to fetch from S3:`, s3Err);
      }
    }

    // 2. Fallback to querying all daily records for this month from DynamoDB (old architecture)
    console.log(`[DynamoDB] Falling back to querying DAY# records for tenant ${tenantId}`);
    const queryRes = await dynamo.send(new QueryCommand({
      TableName: SNAPSHOTS_TABLE,
      KeyConditionExpression: "tenantId = :t AND begins_with(snapshotId, :prefix)",
      ExpressionAttributeValues: {
        ":t": tenantId,
        ":prefix": `DAY#${currentMonthStr}`
      }
    }));

    if (!queryRes.Items || queryRes.Items.length === 0) {
      // Fallback to month record just in case, or return empty
      const getRes = await dynamo.send(new GetCommand({
        TableName: SNAPSHOTS_TABLE,
        Key: { tenantId, snapshotId: `MONTH#${currentMonthStr}` }
      }));

      if (!getRes.Item) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ success: true, data: {
            dailyItems: [],
            totalCost: 0,
            currency: "USD",
            updatedAt: new Date().toISOString(),
            message: "No data available for current month yet."
          }})
        };
      }
      
      const fallbackItems = [];
      for (const [date, cost] of Object.entries(getRes.Item.dailySpend || {})) {
        fallbackItems.push({
          fullDate: date,
          service: "Aggregate",
          operation: "Unknown",
          region: "",
          lineItemType: "Usage",
          usageAmount: 0,
          cost
        });
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true, data: {
          dailyItems: fallbackItems,
          totalCost: getRes.Item.totalCost || 0,
          currency: getRes.Item.currency || "USD",
          updatedAt: getRes.Item.updatedAt
        }})
      };
    }

    // Process all daily records into a rich dataset for the frontend
    let totalCost = 0;
    const dailyItems = [];
    let updatedAt = "";

    for (const item of queryRes.Items) {
      totalCost += item.totalCost || 0;
      if (item.updatedAt > updatedAt) updatedAt = item.updatedAt;
      
      // Extract the date from DAY#YYYY-MM-DD
      const date = item.snapshotId.split('#')[1];
      
      if (item.items && item.items.length > 0) {
        // Detailed items exist (new format)
        for (const detail of item.items) {
          dailyItems.push({
            date,
            service: detail.service,
            operation: detail.operation,
            region: detail.region || "",
            lineItemType: detail.lineItemType || "Usage",
            usageAmount: detail.usageAmount || 0,
            cost: detail.cost
          });
        }
      } else {
        // Fallback for older daily records without detailed items
        for (const [service, cost] of Object.entries(item.services || {})) {
          dailyItems.push({
            date,
            service,
            operation: "Unknown",
            region: "",
            lineItemType: "Usage",
            usageAmount: 0,
            cost: cost
          });
        }
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, data: {
        dailyItems,
        totalCost,
        currency: "USD",
        updatedAt
      }})
    };
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Internal Server Error" })
    };
  }
};
