import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand } from "@aws-sdk/client-athena";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const athena = new AthenaClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE ?? "cloudpenny-snapshots-dev";
const env = process.env.ENVIRONMENT || "dev";
const SNAPSHOTS_BUCKET = `cloudpenny-snapshot-data-${env}`;

export const handler = async (event) => {
  console.log("=== saveSnapshot Lambda INVOKED ===");
  console.log("Full EventBridge Event:", JSON.stringify(event, null, 2));

  try {
    // 1. Extract queryExecutionId from EventBridge event
    const queryExecutionId = event.detail?.queryExecutionId;
    console.log(`[STEP 1] Extracted queryExecutionId: ${queryExecutionId}`);

    if (!queryExecutionId) {
      console.warn("[STEP 1 FAIL] No queryExecutionId found in event.detail. Full detail:", JSON.stringify(event.detail));
      return;
    }

    // 2. Fetch Query Execution to get the original SQL string (which contains our tenantId metadata)
    console.log(`[STEP 2] Fetching Athena query execution for: ${queryExecutionId}`);
    const execRes = await athena.send(new GetQueryExecutionCommand({
      QueryExecutionId: queryExecutionId
    }));

    const queryState = execRes.QueryExecution?.Status?.State;
    const queryStr = execRes.QueryExecution?.Query || "";
    const outputLocation = execRes.QueryExecution?.ResultConfiguration?.OutputLocation || "N/A";
    
    console.log(`[STEP 2] Query State: ${queryState}`);
    console.log(`[STEP 2] Output Location: ${outputLocation}`);
    console.log(`[STEP 2] SQL Query (first 500 chars): ${queryStr.substring(0, 500)}`);

    // Skip non-CloudPenny queries (they won't have our metadata comments)
    if (!queryStr.includes("--tenantId=")) {
      console.log("[STEP 2 SKIP] This Athena query does not contain CloudPenny metadata (--tenantId=). Skipping — this is likely a non-CloudPenny query.");
      return;
    }

    // Parse our injected metadata from SQL comments
    const tenantMatch = queryStr.match(/--tenantId=([a-zA-Z0-9-_]+)/);
    const accountMatch = queryStr.match(/--awsAccountId=([0-9]+)/);
    
    if (!tenantMatch || !accountMatch) {
      console.warn("[STEP 2 FAIL] Could not parse tenantId or awsAccountId from SQL comments.");
      console.warn("  tenantMatch:", tenantMatch);
      console.warn("  accountMatch:", accountMatch);
      console.warn("  Full query:", queryStr);
      return;
    }

    const tenantId = tenantMatch[1];
    const awsAccountId = accountMatch[1];
    
    console.log(`[STEP 2 OK] Tenant: ${tenantId}, AWS Account: ${awsAccountId}`);

    // 3. Fetch ALL Query Results (with pagination)
    console.log(`[STEP 3] Fetching Athena query results...`);
    
    let allRows = [];
    let nextToken = undefined;
    let pageCount = 0;
    
    do {
      const params = { QueryExecutionId: queryExecutionId };
      if (nextToken) params.NextToken = nextToken;
      
      const resultsRes = await athena.send(new GetQueryResultsCommand(params));
      const rows = resultsRes.ResultSet?.Rows || [];
      
      pageCount++;
      console.log(`[STEP 3] Page ${pageCount}: received ${rows.length} rows`);
      
      if (pageCount === 1 && rows.length > 0) {
        // First page includes header row — skip it but collect the rest
        allRows.push(...rows.slice(1));
      } else {
        allRows.push(...rows);
      }
      
      nextToken = resultsRes.NextToken;
    } while (nextToken);
    
    console.log(`[STEP 3 OK] Total data rows fetched: ${allRows.length} (across ${pageCount} pages)`);

    if (allRows.length === 0) {
      console.log("[STEP 3 SKIP] Query returned no data rows (only headers or empty). Nothing to snapshot.");
      return;
    }

    // 4. Structure the Data for the Dashboard
    console.log(`[STEP 4] Structuring data...`);
    
    let totalCost = 0;
    const services = {};
    const dailySpend = {};
    const dailyItems = [];
    let currentMonth = "";
    let parseErrors = 0;

    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i].Data;
      
      if (!row || row.length < 7) {
        parseErrors++;
        console.warn(`[STEP 4 WARN] Row ${i} has insufficient columns (${row?.length || 0}). Skipping.`);
        continue;
      }

      // SELECT service, operation, region, line_item_type, usage_date, usage_amount, total_cost
      const serviceName = row[0]?.VarCharValue || "Unknown";
      const operation = row[1]?.VarCharValue || "None";
      const region = row[2]?.VarCharValue || "";
      const lineItemType = row[3]?.VarCharValue || "Usage";
      const usageDate = row[4]?.VarCharValue || ""; // YYYY-MM-DD
      const usageAmount = parseFloat(row[5]?.VarCharValue || "0");
      const cost = parseFloat(row[6]?.VarCharValue || "0");

      // Skip 0 cost items as requested
      if (cost === 0) {
        continue;
      }

      if (!currentMonth && usageDate) {
        currentMonth = usageDate.substring(0, 7); // Extract YYYY-MM
      }

      totalCost += cost;
      
      services[serviceName] = (services[serviceName] || 0) + cost;
      dailySpend[usageDate] = (dailySpend[usageDate] || 0) + cost;

      dailyItems.push({
        date: usageDate,
        service: serviceName,
        operation: operation,
        region: region,
        lineItemType: lineItemType,
        usageAmount: usageAmount,
        cost: cost
      });
    }

    if (!currentMonth) {
      // Default to current UTC month if no dates found
      const now = new Date();
      currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    const snapshotId = `MONTH#${currentMonth}`;

    console.log(`[STEP 4 OK] Aggregation complete:`);
    console.log(`  - Snapshot ID: ${snapshotId}`);
    console.log(`  - Total Cost: $${totalCost.toFixed(4)}`);
    console.log(`  - Services: ${Object.keys(services).length}`);
    console.log(`  - Daily dates: ${Object.keys(dailySpend).length}`);
    console.log(`  - Parse errors: ${parseErrors}`);

    // 5. Upsert Monthly Snapshot in DynamoDB
    console.log(`[STEP 5] Writing MONTHLY snapshot (${snapshotId}) to DynamoDB table: ${SNAPSHOTS_TABLE}...`);
    
    try {
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
      console.log(`[STEP 5 OK] Monthly snapshot ${snapshotId} saved successfully.`);
    } catch (monthlyErr) {
      console.error(`[STEP 5 FAIL] Failed to write monthly snapshot:`, monthlyErr);
      // Don't throw yet — still try to write daily snapshots
    }

    // 6. Upload Detailed Data to S3 for the Dashboard
    const s3Key = `${tenantId}/dashboard-${snapshotId}.json`;
    console.log(`[STEP 6] Uploading ${dailyItems.length} detailed daily items to S3: s3://${SNAPSHOTS_BUCKET}/${s3Key}`);
    
    try {
      const payload = {
        success: true,
        data: {
          dailyItems: dailyItems,
          totalCost: totalCost,
          currency: "USD",
          updatedAt: new Date().toISOString()
        }
      };
      
      await s3.send(new PutObjectCommand({
        Bucket: SNAPSHOTS_BUCKET,
        Key: s3Key,
        Body: JSON.stringify(payload),
        ContentType: "application/json"
      }));
      console.log(`[STEP 6 OK] S3 upload successful.`);
    } catch (s3Err) {
      console.error(`[STEP 6 FAIL] Failed to upload JSON to S3:`, s3Err);
    }

    console.log(`=== saveSnapshot Lambda COMPLETE for tenant ${tenantId} ===`);

  } catch (err) {
    console.error("=== saveSnapshot Lambda FATAL ERROR ===", err);
    console.error("Error name:", err.name);
    console.error("Error message:", err.message);
    console.error("Error stack:", err.stack);
    throw err;
  }
};
