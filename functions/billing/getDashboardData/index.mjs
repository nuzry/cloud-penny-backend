import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "cloudpenny-snapshots-dev";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const extractTenantId = (event) =>
  event?.requestContext?.authorizer?.jwt?.claims?.sub ??
  event?.requestContext?.authorizer?.claims?.sub ??
  null;

const currentMonth = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const handler = async (event) => {
  try {
    const tenantId = extractTenantId(event);
    if (!tenantId) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    const requestedMonth = event?.queryStringParameters?.month;
    const month = requestedMonth && MONTH_RE.test(requestedMonth) ? requestedMonth : currentMonth();

    console.log(`Fetching dashboard data for tenant ${tenantId}, month ${month}`);

    // Primary path: Query the bounded DAY# items for this month directly.
    // No Scan (single partition key + sort-key prefix), no S3 round trip —
    // each DAY# item already carries a capped, pre-sorted `items` array
    // (see saveSnapshot), so this is a single fast, cheap request.
    const queryRes = await dynamo.send(new QueryCommand({
      TableName: SNAPSHOTS_TABLE,
      KeyConditionExpression: "tenantId = :t AND begins_with(snapshotId, :prefix)",
      ExpressionAttributeValues: {
        ":t": tenantId,
        ":prefix": `DAY#${month}`
      }
    }));

    const dayItems = queryRes.Items || [];

    if (dayItems.length === 0) {
      // Graceful degradation for a tenant with only a coarse MONTH# rollup
      // so far (e.g. brand new, or before their first daily breakdown lands).
      const getRes = await dynamo.send(new GetCommand({
        TableName: SNAPSHOTS_TABLE,
        Key: { tenantId, snapshotId: `MONTH#${month}` }
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

      const fallbackItems = Object.entries(getRes.Item.dailyTotals || {}).map(([date, cost]) => ({
        date,
        service: "Aggregate",
        operation: "Unknown",
        region: "",
        lineItemType: "Usage",
        usageAmount: 0,
        cost
      }));

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

    // Expand each day's bounded `items` array back into the flat row shape
    // the frontend already renders. Field names/envelope are unchanged from
    // before, so no frontend changes are required.
    let totalCost = 0;
    let updatedAt = "";
    const dailyItems = [];

    for (const item of dayItems) {
      totalCost += item.totalCost || 0;
      if (item.updatedAt > updatedAt) updatedAt = item.updatedAt;

      for (const row of item.items || []) {
        dailyItems.push({
          date: item.date,
          service: row.service,
          operation: row.operation,
          region: row.region || "",
          lineItemType: row.lineItemType || "Usage",
          usageAmount: row.usageAmount || 0,
          cost: row.cost
        });
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
