import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "cloudpenny-snapshots-dev";

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
    const snapshotId = `MONTH#${currentMonthStr}`;

    console.log(`Fetching dashboard data for tenant ${tenantId}, snapshot ${snapshotId}`);

    const res = await dynamo.send(new GetCommand({
      TableName: SNAPSHOTS_TABLE,
      Key: { tenantId, snapshotId }
    }));

    if (!res.Item) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailySpend: {},
          services: {},
          totalCost: 0,
          currency: "USD",
          updatedAt: new Date().toISOString(),
          message: "No data available for current month yet."
        })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dailySpend: res.Item.dailySpend || {},
        services: res.Item.services || {},
        totalCost: res.Item.totalCost || 0,
        currency: res.Item.currency || "USD",
        updatedAt: res.Item.updatedAt
      })
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
