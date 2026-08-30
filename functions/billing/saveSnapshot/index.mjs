import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand } from "@aws-sdk/client-athena";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

const athena = new AthenaClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE ?? "cloudpenny-snapshots-dev";

// Below this magnitude a cost is treated as zero. Athena SUMs of many tiny
// per-request charges (and their JS re-aggregation here) leave floating-point
// "dust" like -3.25e-19 instead of an exact 0 — confirmed present in
// production snapshots. An exact `cost === 0` check never catches that, so
// every near-zero service/operation combo was being kept forever, bloating
// items with noise that also confused the AI's view of "what costs money".
const COST_EPSILON = 1e-6;

// Per-day DynamoDB item size safety valve. A DAY# item's size is bounded by
// (top-N line items + one "Other" rollup per distinct service×lineItemType),
// not by raw row count, so this should never realistically fire — but if it
// ever does, we want a loud CloudWatch signal instead of a silent write
// failure once some tenant's data shape crosses the real 400KB item limit.
const ITEM_SIZE_WARN_BYTES = 300_000;

// Number of highest-|cost| (service, operation, region, lineItemType) rows to
// keep verbatim per day. Everything beyond this is re-aggregated into small
// "Other" rows per (service, lineItemType) — so totals per service are always
// exact, only the operation-level drill-down tail is collapsed. This is what
// keeps a DAY# item's size bounded regardless of how many distinct
// operation/region combinations a tenant's account produces in a day.
const TOP_ITEMS_PER_DAY = 40;

const round = (n) => Math.round(n * 1e8) / 1e8; // 8dp is ample for USD-scale billing data

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

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
    // When this query was actually submitted to Athena — used below as a
    // monotonic ordering guard on the MONTH# rollup write, since two
    // saveSnapshot invocations can run concurrently (e.g. two CUR file drops
    // close together) and finish in a different order than they started in.
    const submittedAt = execRes.QueryExecution?.Status?.SubmissionDateTime;
    const submittedAtIso = submittedAt ? new Date(submittedAt).toISOString() : new Date().toISOString();

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
    const billingPeriodMatch = queryStr.match(/--billingPeriod=(\d{4}-\d{2})/);

    if (!tenantMatch || !accountMatch) {
      console.warn("[STEP 2 FAIL] Could not parse tenantId or awsAccountId from SQL comments.");
      console.warn("  tenantMatch:", tenantMatch);
      console.warn("  accountMatch:", accountMatch);
      console.warn("  Full query:", queryStr);
      return;
    }

    const tenantId = tenantMatch[1];
    const awsAccountId = accountMatch[1];
    // billingPeriod is the authoritative month for this ENTIRE result set now
    // that processCurUpdate scopes the query to one billing_period partition —
    // no more inferring the month from whichever row happens to come first.
    const billingPeriod = billingPeriodMatch ? billingPeriodMatch[1] : null;

    console.log(`[STEP 2 OK] Tenant: ${tenantId}, AWS Account: ${awsAccountId}, Billing Period: ${billingPeriod || "(missing — legacy query)"}`);

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

    // 4. Parse rows and group by day. Because the query is now scoped to a
    // single billing_period, every row here belongs to the SAME month —
    // there is no cross-month mixing to worry about.
    console.log(`[STEP 4] Parsing and grouping rows by day...`);

    const byDay = new Map(); // date -> array of { service, operation, region, lineItemType, usageAmount, cost }
    let parseErrors = 0;
    let inferredMonth = billingPeriod;

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

      if (!usageDate || Math.abs(cost) < COST_EPSILON) {
        continue; // skip undated rows and floating-point dust around zero
      }

      if (!inferredMonth) {
        inferredMonth = usageDate.substring(0, 7); // fallback for a legacy query without the billingPeriod tag
      }

      if (!byDay.has(usageDate)) byDay.set(usageDate, []);
      byDay.get(usageDate).push({ service: serviceName, operation, region, lineItemType, usageAmount, cost });
    }

    if (!inferredMonth) {
      const now = new Date();
      inferredMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    if (byDay.size === 0) {
      console.log("[STEP 4 SKIP] All rows were filtered out (no dated rows above the cost epsilon). Nothing to snapshot.");
      return;
    }

    console.log(`[STEP 4 OK] Grouped into ${byDay.size} day(s) for month ${inferredMonth}. Parse errors: ${parseErrors}`);

    // 5. Build one bounded DAY# item per day, plus a MONTH# rollup.
    //
    // A DAY# item's `items` array holds only the TOP_ITEMS_PER_DAY highest-
    // |cost| rows verbatim; everything past that is folded into small "Other"
    // rows per (service, lineItemType) so per-service/per-day totals are
    // always exact — only the operation-level drill-down tail is truncated.
    // This bounds item size by (topN + distinct service×lineItemType pairs),
    // never by raw line-item count, which is what actually protects us from
    // the 400KB DynamoDB item limit as tenants scale up.
    console.log(`[STEP 5] Building bounded day snapshots...`);

    const dayItems = [];
    let monthTotalCost = 0;
    const monthServices = {};
    const monthRegions = {};
    const dailyTotals = {};

    for (const [date, rows] of byDay.entries()) {
      const services = {};
      const regions = {};
      const lineItemTypes = {};
      let dayTotal = 0;

      for (const r of rows) {
        services[r.service] = (services[r.service] || 0) + r.cost;
        if (r.region) regions[r.region] = (regions[r.region] || 0) + r.cost;
        lineItemTypes[r.lineItemType] = (lineItemTypes[r.lineItemType] || 0) + r.cost;
        dayTotal += r.cost;
      }

      const sorted = [...rows].sort((a, b) => Math.abs(b.cost) - Math.abs(a.cost));
      const kept = sorted.slice(0, TOP_ITEMS_PER_DAY);
      const overflow = sorted.slice(TOP_ITEMS_PER_DAY);

      const otherByKey = new Map(); // `${service}|${lineItemType}` -> { service, lineItemType, cost, usageAmount }
      for (const r of overflow) {
        const key = `${r.service}|${r.lineItemType}`;
        const existing = otherByKey.get(key);
        if (existing) {
          existing.cost += r.cost;
          existing.usageAmount += r.usageAmount;
        } else {
          otherByKey.set(key, { service: r.service, lineItemType: r.lineItemType, cost: r.cost, usageAmount: r.usageAmount });
        }
      }

      const items = [
        ...kept.map(r => ({
          service: r.service, operation: r.operation, region: r.region,
          lineItemType: r.lineItemType, usageAmount: round(r.usageAmount), cost: round(r.cost)
        })),
        ...[...otherByKey.values()].map(r => ({
          service: r.service, operation: "Other (aggregated)", region: "",
          lineItemType: r.lineItemType, usageAmount: round(r.usageAmount), cost: round(r.cost)
        }))
      ];

      const roundedServices = Object.fromEntries(Object.entries(services).map(([k, v]) => [k, round(v)]));
      const roundedRegions = Object.fromEntries(Object.entries(regions).map(([k, v]) => [k, round(v)]));
      const roundedLineItemTypes = Object.fromEntries(Object.entries(lineItemTypes).map(([k, v]) => [k, round(v)]));

      const dayItem = {
        tenantId,
        snapshotId: `DAY#${date}`,
        date,
        totalCost: round(dayTotal),
        currency: "USD",
        services: roundedServices,
        regions: roundedRegions,
        lineItemTypes: roundedLineItemTypes,
        items,
        awsAccountId,
        updatedAt: new Date().toISOString()
      };

      const sizeBytes = Buffer.byteLength(JSON.stringify(dayItem), "utf8");
      if (sizeBytes > ITEM_SIZE_WARN_BYTES) {
        console.warn(`[STEP 5 WARN] DAY#${date} item is ${sizeBytes} bytes — approaching the 400KB DynamoDB item limit. Tenant: ${tenantId}.`);
      }

      dayItems.push(dayItem);

      monthTotalCost += dayTotal;
      dailyTotals[date] = round(dayTotal);
      for (const [svc, cost] of Object.entries(services)) {
        monthServices[svc] = (monthServices[svc] || 0) + cost;
      }
      for (const [rgn, cost] of Object.entries(regions)) {
        monthRegions[rgn] = (monthRegions[rgn] || 0) + cost;
      }
    }

    const roundedMonthServices = Object.fromEntries(Object.entries(monthServices).map(([k, v]) => [k, round(v)]));
    const roundedMonthRegions = Object.fromEntries(Object.entries(monthRegions).map(([k, v]) => [k, round(v)]));

    console.log(`[STEP 5 OK] Built ${dayItems.length} day item(s). Month total: $${round(monthTotalCost)}, services: ${Object.keys(roundedMonthServices).length}`);

    // 6. Write all DAY# items via chunked BatchWrite (max 25 per request).
    // BatchWriteItem can partially fail under throttling and return
    // UnprocessedItems WITHOUT throwing — ignoring that would silently drop
    // day items exactly like the original all-history-query bug did, just
    // through a different door. Retry unprocessed items with backoff before
    // giving up and letting SQS/EventBridge retry the whole (idempotent) write.
    console.log(`[STEP 6] Writing ${dayItems.length} DAY# item(s) to ${SNAPSHOTS_TABLE}...`);

    for (const batch of chunk(dayItems, 25)) {
      let requestItems = { [SNAPSHOTS_TABLE]: batch.map(item => ({ PutRequest: { Item: item } })) };
      let attempt = 0;

      while (Object.keys(requestItems).length > 0) {
        let res;
        try {
          res = await dynamo.send(new BatchWriteCommand({ RequestItems: requestItems }));
        } catch (batchErr) {
          console.error(`[STEP 6 FAIL] Batch write failed for tenant ${tenantId}:`, batchErr);
          throw batchErr; // let SQS/EventBridge retry — the whole write is idempotent
        }

        requestItems = res.UnprocessedItems || {};
        if (Object.keys(requestItems).length === 0) break;

        attempt++;
        if (attempt > 5) {
          throw new Error(`[STEP 6 FAIL] ${Object.values(requestItems)[0]?.length || 0} item(s) still unprocessed for tenant ${tenantId} after ${attempt} attempts.`);
        }
        console.warn(`[STEP 6 RETRY] Attempt ${attempt}: retrying unprocessed items for tenant ${tenantId}.`);
        await new Promise(r => setTimeout(r, 100 * 2 ** attempt)); // exponential backoff
      }
    }
    console.log(`[STEP 6 OK] Day items written.`);

    // 7. Upsert the MONTH# rollup — small (bounded by distinct service count +
    // up to 31 daily totals). The chat query engine reads DAY# items first,
    // so this rollup is the coarse fallback for months whose day items were
    // never written, and the source for the availability manifest.
    //
    // Guarded by submittedAt: two saveSnapshot invocations for the same
    // tenant/month can run concurrently (e.g. two CUR file drops close
    // together each trigger their own Athena query), and DynamoDB gives no
    // ordering guarantee on which UpdateCommand lands last. Without this
    // guard, an invocation for an OLDER, less-complete query could finish
    // AFTER a newer one and silently overwrite the MONTH# rollup with stale
    // data — exactly the bug that made getSpendByService report the wrong
    // top service: the DAY# items (written per-date, so they can't collide)
    // stayed correct while the MONTH# rollup regressed to an earlier query's
    // numbers. The per-day items were never wrong; only this shared key was.
    console.log(`[STEP 7] Writing MONTH#${inferredMonth} rollup to ${SNAPSHOTS_TABLE}...`);

    try {
      await dynamo.send(new UpdateCommand({
        TableName: SNAPSHOTS_TABLE,
        Key: { tenantId, snapshotId: `MONTH#${inferredMonth}` },
        UpdateExpression: `
          SET totalCost = :tc,
              currency = :cur,
              services = :svc,
              regions = :rgn,
              dailyTotals = :dt,
              dayCount = :dc,
              updatedAt = :ua,
              awsAccountId = :acc,
              lastQuerySubmittedAt = :qsa
        `,
        ConditionExpression: "attribute_not_exists(lastQuerySubmittedAt) OR :qsa > lastQuerySubmittedAt",
        ExpressionAttributeValues: {
          ":tc": round(monthTotalCost),
          ":cur": "USD",
          ":svc": roundedMonthServices,
          ":rgn": roundedMonthRegions,
          ":dt": dailyTotals,
          ":dc": dayItems.length,
          ":ua": new Date().toISOString(),
          ":acc": awsAccountId,
          ":qsa": submittedAtIso
        }
      }));
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        console.log(`[STEP 7 SKIP] A MONTH#${inferredMonth} rollup from a more recently submitted query already exists — not overwriting it with this older result.`);
      } else {
        throw err;
      }
    }

    console.log(`[STEP 7 OK] MONTH#${inferredMonth} rollup saved.`);
    console.log(`=== saveSnapshot Lambda COMPLETE for tenant ${tenantId} ===`);

  } catch (err) {
    console.error("=== saveSnapshot Lambda FATAL ERROR ===", err);
    console.error("Error name:", err.name);
    console.error("Error message:", err.message);
    console.error("Error stack:", err.stack);
    throw err;
  }
};
