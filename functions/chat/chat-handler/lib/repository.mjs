import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Data access layer. Pure DynamoDB reads — no AI concepts, no formatting,
 * no business rules. Everything above this layer (the query engine, the
 * tools, the agent) depends on this SHAPE, not on DynamoDB, which is what
 * lets the eval harness swap in a fixture repository and exercise the whole
 * chat path offline.
 *
 * Snapshot item shapes written by functions/billing/saveSnapshot:
 *   MONTH#YYYY-MM  { totalCost, currency, services{}, regions{}, dailyTotals{}, dayCount, updatedAt }
 *   DAY#YYYY-MM-DD { date, totalCost, currency, services{}, regions{}, lineItemTypes{}, items[] }
 *
 * Note which aggregates are EXACT: `services`, `regions` and `lineItemTypes`
 * on a DAY# item are summed over every CUR row before truncation, whereas
 * `items` keeps only the top rows verbatim and folds the tail into
 * "Other (aggregated)". The query engine relies on that distinction.
 */

// A single tenant-month of DAY# items can exceed DynamoDB's 1MB query page
// once `items` arrays are included, so every range read paginates. The old
// implementation read one page and silently dropped the rest.
const MAX_PAGES = 20;

// Upper bound on months listed for the availability manifest. Newest first,
// so a long-lived tenant shows recent history rather than ancient history.
const MAX_MONTHS_LISTED = 24;

export function createDynamoRepository({ docClient, tables }) {
  const { tenants, snapshots, alerts } = tables;

  async function queryAll(params) {
    const items = [];
    let cursor;
    let pages = 0;

    do {
      const res = await docClient.send(new QueryCommand({ ...params, ExclusiveStartKey: cursor }));
      items.push(...(res.Items || []));
      cursor = res.LastEvaluatedKey;
      pages++;
    } while (cursor && pages < MAX_PAGES);

    return items;
  }

  return {
    async getTenant(tenantId) {
      const { Item } = await docClient.send(new GetCommand({
        TableName: tenants,
        Key: { tenantId },
      }));
      return Item ?? null;
    },

    async getMonthSnapshot(tenantId, month) {
      const { Item } = await docClient.send(new GetCommand({
        TableName: snapshots,
        Key: { tenantId, snapshotId: `MONTH#${month}` },
      }));
      return Item ?? null;
    },

    /** Every MONTH# rollup the tenant has, newest first. Powers the availability manifest. */
    async listMonths(tenantId) {
      const res = await docClient.send(new QueryCommand({
        TableName: snapshots,
        KeyConditionExpression: "tenantId = :t AND begins_with(snapshotId, :prefix)",
        ExpressionAttributeValues: { ":t": tenantId, ":prefix": "MONTH#" },
        ScanIndexForward: false,
        Limit: MAX_MONTHS_LISTED,
      }));

      return (res.Items || []).map((item) => ({ ...item, month: item.snapshotId.slice("MONTH#".length) }));
    },

    /**
     * DAY# items across an inclusive date range.
     *
     * `includeItems: false` projects away the big per-row `items` array,
     * which is most of a DAY# item's bytes. Any question answerable from the
     * exact pre-aggregated maps (cost by service / region / line item type /
     * day) therefore transfers a fraction of the data.
     */
    async listDays(tenantId, startDate, endDate, { includeItems = false } = {}) {
      const params = {
        TableName: snapshots,
        KeyConditionExpression: "tenantId = :t AND snapshotId BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":t": tenantId,
          ":start": `DAY#${startDate}`,
          ":end": `DAY#${endDate}`,
        },
      };

      if (!includeItems) {
        params.ProjectionExpression = "#d, #tc, #cur, #svc, #rgn, #lit";
        params.ExpressionAttributeNames = {
          "#d": "date",
          "#tc": "totalCost",
          "#cur": "currency",
          "#svc": "services",
          "#rgn": "regions",
          "#lit": "lineItemTypes",
        };
      }

      const items = await queryAll(params);
      return items.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    },

    async listAlerts(tenantId, limit) {
      const res = await docClient.send(new QueryCommand({
        TableName: alerts,
        KeyConditionExpression: "tenantId = :t",
        ExpressionAttributeValues: { ":t": tenantId },
        ScanIndexForward: false, // newest first, same ordering as the Alerts page
        Limit: limit,
      }));
      return res.Items || [];
    },

    async countAlerts(tenantId, cap = 25) {
      const res = await docClient.send(new QueryCommand({
        TableName: alerts,
        KeyConditionExpression: "tenantId = :t",
        ExpressionAttributeValues: { ":t": tenantId },
        Select: "COUNT",
        Limit: cap,
      }));
      return res.Count ?? 0;
    },
  };
}
