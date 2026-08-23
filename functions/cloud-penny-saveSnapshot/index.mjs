import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand } from "@aws-sdk/client-athena";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const athena = new AthenaClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE ?? "cloudpenny-snapshots-dev";

export const handler = async (event) => {
  console.log("Received EventBridge Event:", JSON.stringify(event, null, 2));

  try {
    const queryExecutionId = event.detail?.queryExecutionId;
    if (!queryExecutionId) {
      console.warn("No queryExecutionId in event detail.");
      return;
    }

    // 1. Fetch Query Execution to get the original SQL string (which contains our tenantId metadata)
    const execRes = await athena.send(new GetQueryExecutionCommand({
      QueryExecutionId: queryExecutionId
    }));

    const queryStr = execRes.QueryExecution?.Query || "";
    
    // Parse our injected metadata from SQL comments
    const tenantMatch = queryStr.match(/--tenantId=([a-zA-Z0-9-_]+)/);
    const accountMatch = queryStr.match(/--awsAccountId=([0-9]+)/);
    
    if (!tenantMatch || !accountMatch) {
      console.warn("Could not find tenantId or awsAccountId in the SQL query comments. Skipping snapshot.");
      return;
    }

    const tenantId = tenantMatch[1];
    const awsAccountId = accountMatch[1];
    
    console.log(`Processing Athena results for tenant ${tenantId} (${awsAccountId})`);

    // 2. Fetch Query Results
    // Note: For massive result sets, reading the CSV from S3 directly is better. 
    // GetQueryResults returns 1000 rows max per page. Since we grouped by service & day, 
    // it's usually < 1000 rows for a month unless they use a ton of services.
    const resultsRes = await athena.send(new GetQueryResultsCommand({
      QueryExecutionId: queryExecutionId
    }));

    const rows = resultsRes.ResultSet?.Rows || [];
    if (rows.length <= 1) {
      console.log("Query returned no data (only headers or empty).");
      return;
    }

    // 3. Structure the Data for the Dashboard
    let totalCost = 0;
    const services = {};
    const dailySpend = {};
    const dailyData = {};

    let currentMonth = "";

    // Skip the first row (headers)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i].Data;
      // SELECT service, operation, region, line_item_type, usage_date, usage_amount, total_cost
      const serviceName = row[0].VarCharValue || "Unknown";
      const operation = row[1].VarCharValue || "Unknown";
      const region = row[2].VarCharValue || "";
      const lineItemType = row[3].VarCharValue || "Usage";
      const usageDate = row[4].VarCharValue || ""; // YYYY-MM-DD
      const usageAmount = parseFloat(row[5].VarCharValue || "0");
      const cost = parseFloat(row[6].VarCharValue || "0");

      if (!currentMonth && usageDate) {
        currentMonth = usageDate.substring(0, 7); // Extract YYYY-MM
      }

      totalCost += cost;
      
      services[serviceName] = (services[serviceName] || 0) + cost;
      dailySpend[usageDate] = (dailySpend[usageDate] || 0) + cost;

      if (!dailyData[usageDate]) {
        dailyData[usageDate] = { totalCost: 0, services: {}, items: [] };
      }
      dailyData[usageDate].totalCost += cost;
      dailyData[usageDate].services[serviceName] = (dailyData[usageDate].services[serviceName] || 0) + cost;
      dailyData[usageDate].items.push({ service: serviceName, operation, region, lineItemType, usageAmount, cost });
    }

    if (!currentMonth) {
      // Default to current UTC month if no dates found
      const now = new Date();
      currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    const snapshotId = `MONTH#${currentMonth}`;

    console.log(`Aggregated Data for ${snapshotId}: Total Cost: $${totalCost.toFixed(2)}`);

    // 4. Upsert Snapshot in DynamoDB (Monthly)
    await dynamo.send(new UpdateCommand({
      TableName: SNAPSHOTS_TABLE,
      Key: { tenantId, snapshotId },
      UpdateExpression: `
        SET totalCost = :tc,
            currency = :cur,
            services = :svc,
            dailySpend = :ds,
            updatedAt = :ua,
            awsAccountId = :acc
      `,
      ExpressionAttributeValues: {
        ":tc": totalCost,
        ":cur": "USD",
        ":svc": services,
        ":ds": dailySpend,
        ":ua": new Date().toISOString(),
        ":acc": awsAccountId
      }
    }));

    // 5. Upsert Daily Snapshots
    const dailyPromises = Object.entries(dailyData).map(([date, data]) => {
      return dynamo.send(new UpdateCommand({
        TableName: SNAPSHOTS_TABLE,
        Key: { tenantId, snapshotId: `DAY#${date}` },
        UpdateExpression: `
          SET totalCost = :tc,
              currency = :cur,
              services = :svc,
              items = :items,
              updatedAt = :ua,
              awsAccountId = :acc
        `,
        ExpressionAttributeValues: {
          ":tc": data.totalCost,
          ":cur": "USD",
          ":svc": data.services,
          ":items": data.items,
          ":ua": new Date().toISOString(),
          ":acc": awsAccountId
        }
      }));
    });

    await Promise.all(dailyPromises);

    console.log(`Successfully saved snapshot ${snapshotId} and ${dailyPromises.length} daily snapshots for tenant ${tenantId}`);

  } catch (err) {
    console.error("Failed to process Athena results and save snapshot:", err);
    throw err;
  }
};
