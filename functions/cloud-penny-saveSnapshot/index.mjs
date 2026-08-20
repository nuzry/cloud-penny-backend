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

    let currentMonth = "";

    // Skip the first row (headers)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i].Data;
      // SELECT service, usage_date, total_cost
      const serviceName = row[0].VarCharValue || "Unknown";
      const usageDate = row[1].VarCharValue || ""; // YYYY-MM-DD
      const cost = parseFloat(row[2].VarCharValue || "0");

      if (!currentMonth && usageDate) {
        currentMonth = usageDate.substring(0, 7); // Extract YYYY-MM
      }

      totalCost += cost;
      
      services[serviceName] = (services[serviceName] || 0) + cost;
      dailySpend[usageDate] = (dailySpend[usageDate] || 0) + cost;
    }

    if (!currentMonth) {
      // Default to current UTC month if no dates found
      const now = new Date();
      currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    const snapshotId = `MONTH#${currentMonth}`;

    console.log(`Aggregated Data for ${snapshotId}: Total Cost: $${totalCost.toFixed(2)}`);

    // 4. Upsert Snapshot in DynamoDB
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

    console.log(`Successfully saved snapshot ${snapshotId} for tenant ${tenantId}`);

  } catch (err) {
    console.error("Failed to process Athena results and save snapshot:", err);
    throw err;
  }
};
