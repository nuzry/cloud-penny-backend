/**
 * A deterministic synthetic tenant, and an in-memory repository that serves
 * it through the same interface as lib/repository.mjs.
 *
 * Because every layer above the repository takes it as an argument, this one
 * file is enough to run the entire chat path — query engine, tools, agent
 * loop, prompt — with no AWS, no network and no API key. Both the unit tests
 * and the eval harness use it, so a number asserted in a test is the same
 * number the eval scores an answer against.
 *
 * Shape of the fixture (all figures exact, no floating-point surprises):
 *
 *   2026-05  MONTH# rollup only, no DAY# items  -> exercises the coarse fallback
 *   2026-06  30 days                            -> $58.50
 *   2026-07  31 days                            -> $91.45
 *   2026-08  14 days (month in progress)        -> $55.30
 *
 * Per day, every month carries the same rows except the EC2 RunInstances
 * line, which steps 1.00 -> 2.00 -> 3.00 across June/July/August. EC2 is
 * therefore unambiguously both the top service and the biggest driver of the
 * month-over-month increase, which is what most of the golden questions ask.
 */

export const TODAY = "2026-08-15";

export const MONTH_DAY_COUNTS = { "2026-06": 30, "2026-07": 31, "2026-08": 14 };

/** RunInstances cost per day, by month — the only figure that varies. */
const EC2_COMPUTE_BY_MONTH = { "2026-06": 1.0, "2026-07": 2.0, "2026-08": 3.0 };

const round = (n) => Math.round(n * 1e8) / 1e8;

function rowsForDay(month) {
  return [
    { service: "AmazonEC2", operation: "RunInstances", region: "ap-southeast-1", lineItemType: "Usage", usageAmount: 24, cost: EC2_COMPUTE_BY_MONTH[month] },
    { service: "AmazonEC2", operation: "DataTransfer-Out", region: "us-east-1", lineItemType: "Usage", usageAmount: 5, cost: 0.5 },
    { service: "AmazonS3", operation: "PutObject", region: "ap-southeast-1", lineItemType: "Usage", usageAmount: 1000, cost: 0.25 },
    { service: "AWSDataTransfer", operation: "DataTransfer-Out", region: "us-east-1", lineItemType: "Usage", usageAmount: 2, cost: 0.1 },
    { service: "AmazonEC2", operation: "None", region: "", lineItemType: "Tax", usageAmount: 0, cost: 0.15 },
    { service: "AmazonS3", operation: "None", region: "", lineItemType: "Credit", usageAmount: 0, cost: -0.05 },
  ];
}

function buildDay(month, dayNumber) {
  const date = `${month}-${String(dayNumber).padStart(2, "0")}`;
  const items = rowsForDay(month);

  const services = {};
  const regions = {};
  const lineItemTypes = {};
  let totalCost = 0;

  for (const row of items) {
    services[row.service] = round((services[row.service] ?? 0) + row.cost);
    if (row.region) regions[row.region] = round((regions[row.region] ?? 0) + row.cost);
    else regions[""] = round((regions[""] ?? 0) + row.cost);
    lineItemTypes[row.lineItemType] = round((lineItemTypes[row.lineItemType] ?? 0) + row.cost);
    totalCost = round(totalCost + row.cost);
  }

  return { tenantId: "tenant-fixture", snapshotId: `DAY#${date}`, date, totalCost, currency: "USD", services, regions, lineItemTypes, items, updatedAt: `${date}T06:00:00.000Z` };
}

function buildMonthRollup(month, days) {
  const services = {};
  const regions = {};
  const dailyTotals = {};
  let totalCost = 0;

  for (const day of days) {
    dailyTotals[day.date] = day.totalCost;
    totalCost = round(totalCost + day.totalCost);
    for (const [k, v] of Object.entries(day.services)) services[k] = round((services[k] ?? 0) + v);
    for (const [k, v] of Object.entries(day.regions)) regions[k] = round((regions[k] ?? 0) + v);
  }

  return {
    tenantId: "tenant-fixture",
    snapshotId: `MONTH#${month}`,
    totalCost,
    currency: "USD",
    services,
    regions,
    dailyTotals,
    dayCount: days.length,
    updatedAt: `${days[days.length - 1].date}T06:00:00.000Z`,
  };
}

export function buildFixtureData() {
  const daysByMonth = {};
  const monthRollups = {};

  for (const [month, count] of Object.entries(MONTH_DAY_COUNTS)) {
    const days = Array.from({ length: count }, (_, i) => buildDay(month, i + 1));
    daysByMonth[month] = days;
    monthRollups[month] = buildMonthRollup(month, days);
  }

  // May exists only as a coarse rollup — no DAY# items were ever written.
  // Anything needing operations, usage or line item types must degrade
  // honestly for this month rather than silently omitting it.
  monthRollups["2026-05"] = {
    tenantId: "tenant-fixture",
    snapshotId: "MONTH#2026-05",
    totalCost: 40,
    currency: "USD",
    services: { AmazonEC2: 30, AmazonS3: 10 },
    regions: { "ap-southeast-1": 40 },
    dailyTotals: Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [`2026-05-${String(i + 1).padStart(2, "0")}`, round(40 / 31)]),
    ),
    dayCount: 31,
    updatedAt: "2026-05-31T06:00:00.000Z",
  };

  return {
    tenant: {
      tenantId: "tenant-fixture",
      email: "fixture@cloudpenny.test",
      planTier: "free",
      connectionStatus: "VERIFIED",
      awsAccountId: "123456789012",
      dailyRefreshQuota: 1,
      dailyRefreshesUsed: 0,
    },
    daysByMonth,
    monthRollups,
    alerts: [
      { tenantId: "tenant-fixture", createdAt: "2026-08-12T09:14:00.000Z", message: "Unusual spend detected on AmazonEC2: $12.40 above expected.", status: "OPEN" },
      { tenantId: "tenant-fixture", createdAt: "2026-07-03T11:02:00.000Z", message: "Unusual spend detected on AmazonS3: $2.10 above expected.", status: "RESOLVED" },
    ],
  };
}

/**
 * In-memory repository matching createDynamoRepository's interface.
 * `calls` records every read, so tests can assert that a question that should
 * be answerable from the exact aggregate maps never pulled the heavy per-row
 * `items` arrays.
 */
export function createFixtureRepository(data = buildFixtureData()) {
  const allDays = Object.values(data.daysByMonth).flat().sort((a, b) => a.date.localeCompare(b.date));
  const calls = [];

  return {
    calls,
    data,

    async getTenant() {
      calls.push({ op: "getTenant" });
      return data.tenant;
    },

    async getMonthSnapshot(_tenantId, month) {
      calls.push({ op: "getMonthSnapshot", month });
      return data.monthRollups[month] ?? null;
    },

    async listMonths() {
      calls.push({ op: "listMonths" });
      return Object.entries(data.monthRollups)
        .map(([month, item]) => ({ ...item, month }))
        .sort((a, b) => b.month.localeCompare(a.month));
    },

    async listDays(_tenantId, startDate, endDate, { includeItems = false } = {}) {
      calls.push({ op: "listDays", startDate, endDate, includeItems });
      return allDays
        .filter((d) => d.date >= startDate && d.date <= endDate)
        .map((d) => (includeItems ? d : stripItems(d)));
    },

    async listAlerts(_tenantId, limit) {
      calls.push({ op: "listAlerts", limit });
      return data.alerts.slice(0, limit);
    },

    async countAlerts() {
      calls.push({ op: "countAlerts" });
      return data.alerts.length;
    },
  };
}

function stripItems(day) {
  const { items, ...rest } = day;
  return rest;
}
