import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AthenaClient, StartQueryExecutionCommand } from "@aws-sdk/client-athena";
import { GlueClient, GetTablesCommand, GetCrawlerCommand, StartCrawlerCommand } from "@aws-sdk/client-glue";

const athena = new AthenaClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });
const glue = new GlueClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const TABLE = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";

// Default quota if not set by the user (as approved in the plan)
const DEFAULT_DAILY_QUOTA = 1;

export const handler = async (event) => {
  console.log("=== processCurUpdate Lambda INVOKED ===");
  console.log("Received SQS Event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Parse the S3 event that was wrapped in the SQS message
      const s3Event = JSON.parse(record.body);
      
      // Sometimes SQS receives test events from S3 (e.g. s3:TestEvent), skip them
      if (s3Event.Event === "s3:TestEvent") {
        console.log("[SKIP] s3:TestEvent received — ignoring.");
        continue;
      }

      for (const s3Record of s3Event.Records || []) {
        const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, " "));
        const bucketName = s3Record.s3?.bucket?.name || "unknown";
        const eventTime = new Date(s3Record.eventTime).getTime(); // When the S3 file was dropped
        console.log(`[STEP 1] Processing S3 event — Bucket: ${bucketName}, Key: ${objectKey}`);

        // ── VALIDATE S3 KEY STRUCTURE ──────────────────────────────────
        // Expected BCM Data Export key format:
        //   {awsAccountId}/{ExportName}/data/BILLING_PERIOD={YYYY-MM}/{filename}.snappy.parquet
        //
        // We MUST skip:
        //   - metadata/ files (manifest JSON files)
        //   - Non-parquet files (test files, txt, csv, etc.)
        //   - Files not under /data/ path
        //   - Root-level objects (e.g., aws-programmatic-access-test-object)

        // 1. Must be a .parquet file
        if (!objectKey.endsWith('.parquet')) {
          console.log(`[STEP 1 SKIP] Not a parquet file: ${objectKey}. Skipping.`);
          continue;
        }

        // 2. Must follow the expected folder structure
        const parts = objectKey.split('/');
        // Expected: [accountId, exportName, "data", "BILLING_PERIOD=YYYY-MM", "filename.parquet"]
        if (parts.length < 5) {
          console.warn(`[STEP 1 SKIP] Object key ${objectKey} doesn't match expected BCM structure {accountId}/{exportName}/data/BILLING_PERIOD=.../file.parquet. Skipping.`);
          continue;
        }

        // 3. Must be under /data/ path (not /metadata/)
        if (parts[2] !== 'data') {
          console.log(`[STEP 1 SKIP] File is not under /data/ path (found: ${parts[2]}). Skipping.`);
          continue;
        }

        // 4. Must have a valid BILLING_PERIOD partition
        if (!parts[3].startsWith('BILLING_PERIOD=')) {
          console.log(`[STEP 1 SKIP] Missing BILLING_PERIOD partition key in path. Skipping.`);
          continue;
        }

        const tenantId = parts[0];
        const exportName = parts[1];
        const billingPeriod = parts[3].replace('BILLING_PERIOD=', '');
        const fileName = parts[4];
        console.log(`[STEP 1 OK] Valid BCM file detected:`);
        console.log(`  Tenant ID:       ${tenantId}`);
        console.log(`  Export Name:     ${exportName}`);
        console.log(`  Billing Period:  ${billingPeriod}`);
        console.log(`  File Name:       ${fileName}`);

        // 1. Lookup the tenantId in DynamoDB using GetCommand
        console.log(`[STEP 2] Fetching tenant from DynamoDB table "${TABLE}" for tenantId: ${tenantId}`);
        const getRes = await dynamo.send(new GetCommand({
          TableName: TABLE,
          Key: { tenantId }
        }));

        if (!getRes.Item) {
          console.warn(`[STEP 2 FAIL] No tenant found for Tenant ID: ${tenantId}. Skipping.`);
          continue;
        }

        const tenant = getRes.Item;
        const awsAccountId = tenant.awsAccountId;
        if (!awsAccountId) {
          console.warn(`[STEP 2 FAIL] Tenant ${tenantId} does not have an awsAccountId connected. Skipping.`);
          continue;
        }
        console.log(`[STEP 2 OK] Found tenant: ${tenantId}, AWS Account ID: ${awsAccountId}`);

        // 2. Evaluate Quota
        const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD (UTC)
        
        let quota = tenant.dailyRefreshQuota;
        if (quota === undefined || quota === null) {
          quota = DEFAULT_DAILY_QUOTA;
        }
        
        let used = tenant.dailyRefreshesUsed || 0;
        let lastDate = tenant.lastRefreshDate || "";

        console.log(`[STEP 3] Quota check — today(UTC): ${today}, lastRefreshDate: ${lastDate}, used: ${used}, quota: ${quota}`);

        // Reset if it's a new day
        if (lastDate !== today) {
          console.log(`[STEP 3] New day detected (${lastDate} → ${today}). Resetting usage counter.`);
          used = 0;
          lastDate = today;
        }

        // 3. Enforce Quota
        if (used >= quota) {
          console.log(`[QUOTA EXCEEDED] Tenant ${tenantId} (${awsAccountId}) has used ${used}/${quota} refreshes for ${today}. Skipping processing.`);
          continue; // Skip downstream processing, message will be deleted from SQS since we don't throw an error
        }

        // =========================================================
        // START ATHENA QUERY
        // =========================================================
        const env = process.env.ENVIRONMENT || "dev";
        const database = `cloudpenny_curs_${env}`;
        
        // =========================================================
        // GLUE CRAWLER SYNCHRONIZATION
        // =========================================================
        const crawlerName = `cloudpenny-cur-crawler-${env}`;
        console.log(`[CRAWLER] Checking status of Glue Crawler: ${crawlerName}`);
        
        try {
          const crawlerRes = await glue.send(new GetCrawlerCommand({ Name: crawlerName }));
          const state = crawlerRes.Crawler?.State; // READY, RUNNING, or STOPPING
          const lastCrawlStartTime = crawlerRes.Crawler?.LastCrawl?.StartTime ? new Date(crawlerRes.Crawler.LastCrawl.StartTime).getTime() : 0;
          
          console.log(`[CRAWLER] Current state: ${state}`);
          console.log(`[CRAWLER] Last crawl start time: ${lastCrawlStartTime}, S3 Event Time: ${eventTime}`);
          
          if (state === "RUNNING" || state === "STOPPING") {
            // Crawler is busy. Throw to retry.
            console.log(`[CRAWLER] Crawler is currently ${state}. Waiting for it to finish.`);
            throw new Error(`Crawler ${crawlerName} is ${state}. SQS will retry.`);
          } else if (state === "READY") {
            // Check if the crawler needs to run for THIS file
            if (lastCrawlStartTime < eventTime) {
              console.log(`[CRAWLER] Crawler's last run (${lastCrawlStartTime}) is older than the S3 event (${eventTime}). Starting crawler...`);
              await glue.send(new StartCrawlerCommand({ Name: crawlerName }));
              throw new Error(`Crawler ${crawlerName} was READY but stale. Started it. SQS will retry.`);
            } else {
              console.log(`[CRAWLER] Crawler has already run since this file was dropped. Proceeding to Athena.`);
            }
          }
        } catch (e) {
          // If the error was thrown by us for SQS retry, propagate it!
          if (e.message.includes("SQS will retry")) {
            throw e;
          }
          console.warn("[CRAWLER WARN] Failed to get/start crawler, proceeding anyway...", e);
        }

        // 4. Update Quota in DB and Proceed (moved AFTER crawler check so retries don't burn quota)
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

        console.log(`[QUOTA ALLOWED] Tenant ${tenantId} (${awsAccountId}) using refresh ${used}/${quota} for ${today}.`);

        console.log(`[STEP 4] Looking up Glue tables in database: ${database}`);
        
        let tableName = `data`; // Fallback
        try {
          const glueRes = await glue.send(new GetTablesCommand({ DatabaseName: database }));
          if (glueRes.TableList) {
            console.log(`[STEP 4] Found ${glueRes.TableList.length} Glue table(s): ${glueRes.TableList.map(t => t.Name).join(', ')}`);
            const match = glueRes.TableList.find(t => t.StorageDescriptor?.Location?.includes(`/${tenantId}/`));
            if (match) {
              tableName = match.Name;
              console.log(`[STEP 4 OK] Matched Glue table for tenant ${tenantId}: ${tableName}`);
            } else {
              console.log(`[STEP 4] No Glue table matched /${tenantId}/. Using fallback table: ${tableName}`);
              // Log all table locations for debugging
              glueRes.TableList.forEach(t => {
                console.log(`  Table "${t.Name}" → ${t.StorageDescriptor?.Location}`);
              });
            }
          }
        } catch (e) {
          console.warn("[STEP 4 WARN] Failed to lookup Glue tables, falling back to 'data'", e);
        }
        
        const outputLocation = `s3://cloud-penny-athena-results-${env}/${tenantId}/`;
        
        // This query aggregates the raw parquet rows into daily service costs.
        // It injects the tenantId as a custom tag so we can read it later in the EventBridge Lambda!
        // We use --tenantId=${tenantId} as a SQL comment so it's passed through Athena's execution context.
        const queryString = `
          --tenantId=${tenantId}
          --awsAccountId=${awsAccountId}
          SELECT 
            COALESCE(line_item_product_code, 'Unknown') as service,
            COALESCE(line_item_operation, 'Unknown') as operation,
            COALESCE(product_region_code, '') as region,
            COALESCE(line_item_line_item_type, 'Usage') as line_item_type,
            DATE(line_item_usage_start_date) as usage_date,
            SUM(TRY_CAST(line_item_usage_amount AS DOUBLE)) as usage_amount,
            SUM(TRY_CAST(line_item_unblended_cost AS DOUBLE)) as total_cost
          FROM "${database}"."${tableName}"
          WHERE "$path" LIKE '%/${tenantId}/%'
            AND line_item_usage_start_date IS NOT NULL
          GROUP BY 1, 2, 3, 4, 5
        `;

        console.log(`[STEP 5] Starting Athena query for tenant ${tenantId}...`);
        console.log(`[STEP 5] Database: ${database}, Table: ${tableName}`);
        console.log(`[STEP 5] Output Location: ${outputLocation}`);
        
        const startQueryRes = await athena.send(new StartQueryExecutionCommand({
          QueryString: queryString,
          QueryExecutionContext: {
            Database: database
          },
          ResultConfiguration: {
            OutputLocation: outputLocation
          }
        }));

        console.log(`[STEP 5 OK] Athena Query Execution ID: ${startQueryRes.QueryExecutionId}`);
        console.log(`=== processCurUpdate DONE for tenant ${tenantId} ===`);

      }
    } catch (err) {
      console.error("=== processCurUpdate FATAL ERROR ===", err);
      // Throwing the error will cause SQS to retry this specific message
      throw err;
    }
  }
};
