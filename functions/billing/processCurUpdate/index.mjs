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

// ── Allow-lists for values interpolated into the Athena SQL string ─────────
// StartQueryExecutionCommand has no bind-parameter API, so strict validation
// (not just escaping) is the real defense against SQL injection here.
const TENANT_ID_RE = /^[a-f0-9-]{8,64}$/i;           // Cognito sub (UUID shape)
const AWS_ACCOUNT_ID_RE = /^\d{12}$/;                // AWS account IDs are always 12 digits
const BILLING_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // YYYY-MM

// Belt-and-suspenders on top of the regex gates above — never trust a single layer.
const sqlEscape = (value) => String(value).replace(/'/g, "''");

// Attribute name prefix for a per-(tenant, billingPeriod) "a correction landed
// while quota was exhausted and was never reprocessed" marker. See the big
// comment above tryConsumeQuota for why this exists.
const PENDING_PREFIX = "pendingReprocess_";
const pendingKeyRe = new RegExp(`^${PENDING_PREFIX}(\\d{4}-(?:0[1-9]|1[0-2]))$`);

// Quota is tracked per (tenantId, billingPeriod) rather than per (tenantId,
// UTC day). Two bugs this fixes, both discovered live:
//
//  1. AWS re-delivers a BCM Data Export (RefreshCadence: SYNCHRONOUS,
//     Overwrite: OVERWRITE_REPORT — see cloudformation/cur-setup.yml) every
//     time the underlying billing data changes: several times a day for the
//     currently-open month, and again later for late-arriving corrections
//     (RI/SP true-ups, marketplace/support charges, credits) even against a
//     CLOSED prior month. Every one of those deliveries is a legitimate
//     correction to already-recorded usage.
//  2. When quota was tracked as one counter per UTC day, a rare correction to
//     a closed prior month competed with the current month's routine syncs
//     for the same 1-3 daily slots and could be starved indefinitely by
//     whichever period's file happened to land first.
//
// Splitting the counter per billing period means the current month's routine
// cadence can never starve out a correction to a different (older) month, and
// vice versa — each billing period gets its own independent daily quota.
async function tryConsumeQuota(tenantId, quota, today, billingPeriod) {
  const usedAttr = `refreshUsed_${billingPeriod}`;
  const dateAttr = `refreshDate_${billingPeriod}`;

  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { tenantId },
      UpdateExpression: "SET #used = #used + :one",
      ConditionExpression: "#date = :today AND #used < :quota",
      ExpressionAttributeNames: { "#used": usedAttr, "#date": dateAttr },
      ExpressionAttributeValues: { ":one": 1, ":today": today, ":quota": quota },
    }));
    return true;
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
  }

  // Either this is the first refresh ever for this billing period, or the
  // first refresh of a new UTC day for it.
  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { tenantId },
      UpdateExpression: "SET #used = :one, #date = :today",
      ConditionExpression: "attribute_not_exists(#date) OR #date <> :today",
      ExpressionAttributeNames: { "#used": usedAttr, "#date": dateAttr },
      ExpressionAttributeValues: { ":one": 1, ":today": today },
    }));
    return true;
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
  }

  return false; // Quota genuinely exhausted for today, for this billing period.
}

// A quota-blocked event is never just dropped: this records that a newer
// correction exists for this (tenant, billingPeriod) so a future invocation —
// even one triggered by a completely unrelated billing period's file, or by
// tomorrow's first sync — knows to go back and reprocess it. Best-effort:
// bookkeeping failing here must not turn into an SQS retry storm.
async function markPendingReprocess(tenantId, billingPeriod) {
  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { tenantId },
      UpdateExpression: "SET #p = :true",
      ExpressionAttributeNames: { "#p": `${PENDING_PREFIX}${billingPeriod}` },
      ExpressionAttributeValues: { ":true": true },
    }));
  } catch (err) {
    console.warn(`[PENDING] Failed to mark ${billingPeriod} as pending reprocess for tenant ${tenantId}:`, err.message);
  }
}

async function clearPendingReprocess(tenantId, billingPeriod) {
  try {
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { tenantId },
      UpdateExpression: "REMOVE #p",
      ExpressionAttributeNames: { "#p": `${PENDING_PREFIX}${billingPeriod}` },
    }));
  } catch (err) {
    console.warn(`[PENDING] Failed to clear ${billingPeriod} pending-reprocess flag for tenant ${tenantId}:`, err.message);
  }
}

/** Every billing period this tenant has a pending, not-yet-reprocessed correction for. */
function findPendingPeriods(tenant) {
  return Object.keys(tenant)
    .map((key) => key.match(pendingKeyRe))
    .filter(Boolean)
    .map((m) => m[1]);
}

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

        // 5. Both values get interpolated into the Athena SQL string below (no
        // bind-parameter API is available via StartQueryExecutionCommand), so
        // gate them against a strict allow-list before they're trusted further.
        if (!TENANT_ID_RE.test(tenantId)) {
          console.warn(`[STEP 1 SKIP] tenantId "${tenantId}" does not match expected Cognito sub shape. Skipping.`);
          continue;
        }
        if (!BILLING_PERIOD_RE.test(billingPeriod)) {
          console.warn(`[STEP 1 SKIP] billingPeriod "${billingPeriod}" is not a valid YYYY-MM value. Skipping.`);
          continue;
        }

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
        if (!AWS_ACCOUNT_ID_RE.test(awsAccountId)) {
          // saveAwsAccount already validates this at write time — this is a
          // defensive re-check since awsAccountId also gets interpolated into SQL.
          console.warn(`[STEP 2 SKIP] Tenant ${tenantId} has a malformed awsAccountId "${awsAccountId}". Skipping.`);
          continue;
        }
        console.log(`[STEP 2 OK] Found tenant: ${tenantId}, AWS Account ID: ${awsAccountId}`);

        // 2. Evaluate Quota (just for logging here — the actual check-and-increment
        // happens atomically in tryConsumeQuota() after the crawler sync below,
        // so retries triggered by the crawler don't burn quota on their own).
        const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD (UTC)

        let quota = tenant.dailyRefreshQuota;
        if (quota === undefined || quota === null) {
          quota = DEFAULT_DAILY_QUOTA;
        }

        const usedSoFar = tenant[`refreshDate_${billingPeriod}`] === today ? (tenant[`refreshUsed_${billingPeriod}`] || 0) : 0;
        console.log(`[STEP 3] Quota check for ${billingPeriod} — today(UTC): ${today}, lastRefreshDate: ${tenant[`refreshDate_${billingPeriod}`] || ""}, used: ${usedSoFar}, quota: ${quota}`);

        if (usedSoFar >= quota) {
          console.log(`[QUOTA EXCEEDED] Tenant ${tenantId} (${awsAccountId}) has used ${usedSoFar}/${quota} refreshes for ${billingPeriod} on ${today}. Marking pending and skipping for now.`);
          await markPendingReprocess(tenantId, billingPeriod);
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
          // Another concurrent invocation for this tenant already started the
          // crawler between our GetCrawler poll and our StartCrawler call — the
          // state poll above isn't atomic with the start call. Treat this the
          // same as "crawler is busy": retry via SQS rather than proceeding
          // against a possibly-stale Glue table.
          if (e.name === "CrawlerRunningException") {
            console.log(`[CRAWLER] ${crawlerName} was started by a concurrent invocation. SQS will retry.`);
            throw new Error(`Crawler ${crawlerName} already running (concurrent start). SQS will retry.`);
          }
          console.warn("[CRAWLER WARN] Failed to get/start crawler, proceeding anyway...", e);
        }

        // 4. Atomically check-and-consume quota (moved AFTER crawler check so
        // crawler-triggered SQS retries don't burn quota on their own). See
        // tryConsumeQuota() above for why this is scoped per billing period.
        const quotaOk = await tryConsumeQuota(tenantId, quota, today, billingPeriod);
        if (!quotaOk) {
          console.log(`[QUOTA EXCEEDED] Tenant ${tenantId} (${awsAccountId}) hit its quota of ${quota} for ${billingPeriod} on ${today} (race with a concurrent delivery). Marking pending and skipping.`);
          await markPendingReprocess(tenantId, billingPeriod);
          continue;
        }

        console.log(`[QUOTA ALLOWED] Tenant ${tenantId} (${awsAccountId}) consumed a ${billingPeriod} refresh for ${today}.`);

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

        // ── CRITICAL: scope the query to exactly the billing period this file
        // belongs to. Previously this had no date/partition filter at all, so
        // EVERY file drop re-aggregated the tenant's ENTIRE CUR history, and
        // saveSnapshot would then attribute all of it to whichever month
        // happened to sort first in the result set — silently corrupting every
        // other month's snapshot. Filtering on the real `billing_period`
        // partition column (confirmed live via `aws glue get-tables`) makes
        // every query return rows for exactly one month, and also gives Athena
        // real partition pruning (only that month's Parquet is scanned, not
        // the whole tenant history — cheaper and faster as history grows).
        // The tenant `$path` filter is kept as cheap defense-in-depth in case
        // Glue's crawler ever groups multiple tenants into a shared table.
        //
        // tenantId/awsAccountId/billingPeriod are threaded through as SQL
        // comment tags so saveSnapshot can read them back from the query
        // execution metadata — all three are validated against strict
        // allow-lists above (and escaped again here) before being interpolated,
        // since Athena's API has no bind-parameter support for this call.
        //
        // `arbitrary(line_item_currency_code)` is not part of the GROUP BY —
        // it just surfaces the actual billing currency for saveSnapshot to
        // record, instead of that being hardcoded to USD regardless of what
        // currency the payer account actually bills in.
        const startCurQuery = async (period) => {
          const safeTenantId = sqlEscape(tenantId);
          const safeBillingPeriod = sqlEscape(period);
          const queryString = `
            --tenantId=${tenantId}
            --awsAccountId=${awsAccountId}
            --billingPeriod=${period}
            SELECT
              COALESCE(line_item_product_code, 'Unknown') as service,
              COALESCE(line_item_operation, 'None') as operation,
              COALESCE(product_region_code, '') as region,
              COALESCE(line_item_line_item_type, 'Usage') as line_item_type,
              DATE(line_item_usage_start_date) as usage_date,
              SUM(TRY_CAST(line_item_usage_amount AS DOUBLE)) as usage_amount,
              SUM(TRY_CAST(line_item_unblended_cost AS DOUBLE)) as total_cost,
              arbitrary(line_item_currency_code) as currency_code
            FROM "${database}"."${tableName}"
            WHERE billing_period = '${safeBillingPeriod}'
              AND "$path" LIKE '%/${safeTenantId}/%'
              AND line_item_usage_start_date IS NOT NULL
            GROUP BY 1, 2, 3, 4, 5
          `;

          console.log(`[STEP 5] Starting Athena query for tenant ${tenantId}, billing period ${period}...`);
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

          console.log(`[STEP 5 OK] Athena Query Execution ID: ${startQueryRes.QueryExecutionId} for ${period}`);
        };

        await startCurQuery(billingPeriod);
        await clearPendingReprocess(tenantId, billingPeriod);

        // 6. Catch-up: this tenant may have OTHER billing periods sitting on a
        // "quota was exhausted when a correction landed" flag (see
        // markPendingReprocess above) — periods with no NEW S3 event today to
        // naturally re-trigger them. Since each billing period now has its own
        // independent quota, use this invocation as an opportunity to also
        // clear any of those, so a correction is never stuck waiting forever
        // for a fresh file drop on that specific period.
        const pendingPeriods = findPendingPeriods(tenant).filter((p) => p !== billingPeriod);
        for (const pendingPeriod of pendingPeriods) {
          if (!BILLING_PERIOD_RE.test(pendingPeriod)) continue; // defensive: never trust a stored value blindly
          const pendingQuotaOk = await tryConsumeQuota(tenantId, quota, today, pendingPeriod);
          if (!pendingQuotaOk) {
            console.log(`[PENDING] ${pendingPeriod} still over quota for tenant ${tenantId} — leaving it pending.`);
            continue;
          }
          console.log(`[PENDING] Catching up ${pendingPeriod} for tenant ${tenantId} using this invocation's quota window.`);
          await startCurQuery(pendingPeriod);
          await clearPendingReprocess(tenantId, pendingPeriod);
        }

        console.log(`=== processCurUpdate DONE for tenant ${tenantId} ===`);

      }
    } catch (err) {
      console.error("=== processCurUpdate FATAL ERROR ===", err);
      // Throwing the error will cause SQS to retry this specific message
      throw err;
    }
  }
};
