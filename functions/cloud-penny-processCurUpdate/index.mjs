import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AthenaClient, StartQueryExecutionCommand } from "@aws-sdk/client-athena";

const athena = new AthenaClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const TABLE = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";

// Default quota if not set by the user (as approved in the plan)
const DEFAULT_DAILY_QUOTA = 1;

export const handler = async (event) => {
  console.log("Received SQS Event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Parse the S3 event that was wrapped in the SQS message
      const s3Event = JSON.parse(record.body);
      
      // Sometimes SQS receives test events from S3 (e.g. s3:TestEvent), skip them
      if (s3Event.Event === "s3:TestEvent") continue;

      for (const s3Record of s3Event.Records || []) {
        const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, " "));
        console.log(`Processing update for file: ${objectKey}`);

        // The object key format is expected to be: {awsAccountId}/...
        const parts = objectKey.split('/');
        if (parts.length < 2) {
          console.warn(`Object key ${objectKey} doesn't match expected pattern {awsAccountId}/... Skipping.`);
          continue;
        }

        const awsAccountId = parts[0];

        // 1. Lookup the tenantId in DynamoDB using the awsAccountId
        // Note: Using Scan here because there isn't a GSI on awsAccountId yet.
        // For production scale, add a Global Secondary Index (GSI) on awsAccountId and use Query.
        const scanRes = await dynamo.send(new ScanCommand({
          TableName: TABLE,
          FilterExpression: "awsAccountId = :accId",
          ExpressionAttributeValues: { ":accId": awsAccountId }
        }));

        if (!scanRes.Items || scanRes.Items.length === 0) {
          console.warn(`No tenant found for AWS Account ID: ${awsAccountId}. Skipping.`);
          continue;
        }

        const tenant = scanRes.Items[0];
        const tenantId = tenant.tenantId;

        // 2. Evaluate Quota
        const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD (UTC)
        
        let quota = tenant.dailyRefreshQuota;
        if (quota === undefined || quota === null) {
          quota = DEFAULT_DAILY_QUOTA;
        }
        
        let used = tenant.dailyRefreshesUsed || 0;
        let lastDate = tenant.lastRefreshDate || "";

        // Reset if it's a new day
        if (lastDate !== today) {
          used = 0;
          lastDate = today;
        }

        // 3. Enforce Quota
        if (used >= quota) {
          console.log(`[QUOTA EXCEEDED] Tenant ${tenantId} (${awsAccountId}) has used ${used}/${quota} refreshes for ${today}. Skipping processing.`);
          continue; // Skip downstream processing, message will be deleted from SQS since we don't throw an error
        }

        // 4. Update Quota in DB and Proceed
        used += 1;
        
        await dynamo.send(new UpdateCommand({
          TableName: TABLE,
          Key: { tenantId },
          UpdateExpression: "SET dailyRefreshesUsed = :u, lastRefreshDate = :d",
          ExpressionAttributeValues: {
            ":u": used,
            ":d": lastDate
          }
        }));

        console.log(`[QUOTA ALLOWED] Tenant ${tenantId} (${awsAccountId}) using refresh ${used}/${quota} for ${today}. Ready to parse file: ${objectKey}`);
        
        // =========================================================
        // START ATHENA QUERY
        // =========================================================
        const env = process.env.ENVIRONMENT || "dev";
        const database = `cloudpenny_curs_${env}`;
        // The table name is usually the bucket name or folder name determined by the Crawler.
        const tableName = `data`; 
        
        // This query aggregates the raw parquet rows into daily service costs.
        // It injects the tenantId as a custom tag so we can read it later in the EventBridge Lambda!
        // We use --tenantId=${tenantId} as a SQL comment so it's passed through Athena's execution context.
        const queryString = `
          --tenantId=${tenantId}
          --awsAccountId=${awsAccountId}
          SELECT 
            line_item_product_code as service,
            DATE(line_item_usage_start_date) as usage_date,
            SUM(line_item_unblended_cost) as total_cost
          FROM "${database}"."${tableName}"
          WHERE "$path" LIKE '%/${awsAccountId}/%'
          GROUP BY 1, 2
        `;

        console.log(`Starting Athena query for tenant ${tenantId}...`);
        
        const startQueryRes = await athena.send(new StartQueryExecutionCommand({
          QueryString: queryString,
          QueryExecutionContext: {
            Database: database
          },
          ResultConfiguration: {
            OutputLocation: `s3://cloud-penny-athena-results-${env}/`
          }
        }));

        console.log(`Athena Query Execution ID: ${startQueryRes.QueryExecutionId}`);

      }
    } catch (err) {
      console.error("Error processing SQS record:", err);
      // Throwing the error will cause SQS to retry this specific message
      throw err;
    }
  }
};
