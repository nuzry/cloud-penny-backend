import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "cloudpenny-snapshots-dev";
const ALERTS_TABLE = process.env.ALERTS_TABLE || "cloudpenny-alerts-dev";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAILY_RANGE_DAYS = 31; // keeps the range query and the model payload small

// --- TOOL SCHEMAS ---
// OpenAI-compatible function-calling shape (used by Groq's chat-completions
// API), not Bedrock Converse's { toolSpec: { inputSchema: { json } } } shape.

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "getMonthlySpend",
      description: "Returns the total AWS expenditure for a specific month.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "The month to query in YYYY-MM format, e.g., '2026-08'" }
        },
        required: ["month"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getSpendByService",
      description: "Returns every AWS service the tenant used in a specific month along with its cost. To answer 'which service costs me the most' or 'what is my most-used/most significant service', call this and pick the entry with the highest cost yourself — there is no separate 'top service' tool.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "The month to query in YYYY-MM format, e.g., '2026-08'" }
        },
        required: ["month"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getSpendByRegion",
      description: "Returns the breakdown of AWS costs by AWS region (e.g. us-east-1) for a specific month. Use this for questions about where costs are geographically concentrated.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "The month to query in YYYY-MM format, e.g., '2026-08'" }
        },
        required: ["month"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "compareSpendPeriods",
      description: "Compares the total AWS spend between two specific months and returns the absolute and percentage change.",
      parameters: {
        type: "object",
        properties: {
          currentMonth: { type: "string", description: "The more recent month in YYYY-MM format, e.g., '2026-08'" },
          previousMonth: { type: "string", description: "The older month in YYYY-MM format, e.g., '2026-07'" }
        },
        required: ["currentMonth", "previousMonth"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getCostTrend",
      description: "Returns an array of total monthly spends over a period of time to show a trend. Do not use this if they only ask for two specific months.",
      parameters: {
        type: "object",
        properties: {
          startMonth: { type: "string", description: "The starting month in YYYY-MM format." },
          endMonth: { type: "string", description: "The ending month in YYYY-MM format." }
        },
        required: ["startMonth", "endMonth"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getTopCostDrivers",
      description: "Compares the service-level costs between two months and identifies which services increased the most.",
      parameters: {
        type: "object",
        properties: {
          currentMonth: { type: "string", description: "The more recent month in YYYY-MM format." },
          previousMonth: { type: "string", description: "The older month in YYYY-MM format." }
        },
        required: ["currentMonth", "previousMonth"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getDailySpend",
      description: "Returns day-by-day AWS spend totals for a specific date range (max 31 days). Use this for questions about a specific day (e.g. yesterday) or a short recent window, rather than a whole month.",
      parameters: {
        type: "object",
        properties: {
          startDate: { type: "string", description: "Start date in YYYY-MM-DD format, inclusive." },
          endDate: { type: "string", description: "End date in YYYY-MM-DD format, inclusive." }
        },
        required: ["startDate", "endDate"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getForecast",
      description: "Projects the likely total spend for a month based on the days that already have data, using the same (spend so far ÷ days elapsed) × days in month method as the dashboard's 'Forecasted Month' figure. Use this for 'what will I spend', 'projected cost', or 'end of month estimate' questions. Only meaningful for a month still in progress or one that already has partial data.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "The month to forecast in YYYY-MM format, e.g., '2026-08'. Defaults to the current month if omitted." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getRecentAlerts",
      description: "Returns the tenant's most recent AWS Cost Anomaly Detection alerts (unusual spend events CloudPenny has already flagged), newest first. Use this for 'have there been any anomalies', 'any unusual spending', or 'what alerts have I had' questions - do not use getTopCostDrivers for this, that tool compares two months rather than reporting actual raised alerts.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum number of alerts to return, defaults to 5." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getTopOperationsForService",
      description: "Drills down into WHY a service costs what it does for a specific month, by returning its highest-cost individual operations (e.g. 'RunInstances', 'DataTransfer-Out') with their region and cost. Use this for 'why is X so expensive' or 'what specifically am I paying for within X' questions, after you already know X is a significant service (e.g. from getSpendByService).",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "The month to query in YYYY-MM format, e.g., '2026-08'" },
          service: { type: "string", description: "The exact service name as returned by getSpendByService, e.g. 'AmazonEC2'." }
        },
        required: ["month", "service"]
      }
    }
  }
];

// --- TOOL HANDLERS ---

export const handleToolUse = async (docClient, tenantId, toolName, input) => {
  console.log(`[TOOL CALLED] ${toolName} for tenant ${tenantId}`, input);

  try {
    switch (toolName) {
      case "getMonthlySpend":
        return await getMonthlySpend(docClient, tenantId, input.month);

      case "getSpendByService":
        return await getSpendByService(docClient, tenantId, input.month);

      case "getSpendByRegion":
        return await getSpendByRegion(docClient, tenantId, input.month);

      case "compareSpendPeriods":
        return await compareSpendPeriods(docClient, tenantId, input.currentMonth, input.previousMonth);

      case "getCostTrend":
        return await getCostTrend(docClient, tenantId, input.startMonth, input.endMonth);

      case "getTopCostDrivers":
        return await getTopCostDrivers(docClient, tenantId, input.currentMonth, input.previousMonth);

      case "getDailySpend":
        return await getDailySpend(docClient, tenantId, input.startDate, input.endDate);

      case "getTopOperationsForService":
        return await getTopOperationsForService(docClient, tenantId, input.month, input.service);

      case "getForecast":
        return await getForecast(docClient, tenantId, input.month);

      case "getRecentAlerts":
        return await getRecentAlerts(docClient, tenantId, input.limit);

      default:
        // Surfaced as a normal tool result (not thrown) so the model gets a
        // clean signal instead of the whole request failing.
        return { error: `Tool ${toolName} not found.` };
    }
  } catch (error) {
    console.error(`[TOOL ERROR] ${toolName}:`, error);
    return { error: error.message || "Tool execution failed unexpectedly." };
  }
};

// --- TOOL IMPLEMENTATIONS ---

async function fetchSnapshot(docClient, tenantId, month) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: SNAPSHOTS_TABLE,
    Key: { tenantId, snapshotId: `MONTH#${month}` }
  }));
  return Item;
}

async function getMonthlySpend(docClient, tenantId, month) {
  if (!MONTH_RE.test(month || "")) {
    return { error: `"${month}" is not a valid YYYY-MM month.`, noData: true };
  }

  const data = await fetchSnapshot(docClient, tenantId, month);
  if (!data) {
    return { error: `No cost data found for month ${month}.`, noData: true };
  }

  return {
    month,
    totalCost: data.totalCost,
    currency: data.currency || "USD"
  };
}

async function getSpendByService(docClient, tenantId, month) {
  if (!MONTH_RE.test(month || "")) {
    return { error: `"${month}" is not a valid YYYY-MM month.`, noData: true };
  }

  const data = await fetchSnapshot(docClient, tenantId, month);
  if (!data) {
    return { error: `No cost data found for month ${month}.`, noData: true };
  }

  // Sorted server-side, highest cost first. Earlier this returned the raw
  // {service: cost} map and relied on the model to scan it and pick the
  // largest value itself — with several dozen services at fractions of a
  // cent, that arithmetic was unreliable and produced wrong "top service"
  // answers (e.g. naming a $0.0006 service as costliest over an $0.84 one).
  // Sorting here and naming topService explicitly removes that failure mode.
  const services = Object.entries(data.services || {})
    .map(([service, cost]) => ({ service, cost: round(cost) }))
    .sort((a, b) => b.cost - a.cost);

  return {
    month,
    currency: data.currency || "USD",
    services, // already sorted highest to lowest — do not re-sort or re-scan
    topService: services[0] || null
  };
}

async function getSpendByRegion(docClient, tenantId, month) {
  if (!MONTH_RE.test(month || "")) {
    return { error: `"${month}" is not a valid YYYY-MM month.`, noData: true };
  }

  const data = await fetchSnapshot(docClient, tenantId, month);
  if (!data) {
    return { error: `No cost data found for month ${month}.`, noData: true };
  }

  const regionsMap = data.regions || {};
  if (Object.keys(regionsMap).length === 0) {
    return { month, regions: [], note: "No per-region cost data available for this month (some line items, like taxes or support, aren't tied to a region)." };
  }

  // Sorted server-side for the same reason as getSpendByService — the model
  // should never have to scan a raw cost map to find the largest value.
  const regions = Object.entries(regionsMap)
    .map(([region, cost]) => ({ region, cost: round(cost) }))
    .sort((a, b) => b.cost - a.cost);

  return { month, regions, topRegion: regions[0] || null };
}

async function compareSpendPeriods(docClient, tenantId, currentMonth, previousMonth) {
  if (!MONTH_RE.test(currentMonth || "") || !MONTH_RE.test(previousMonth || "")) {
    return { error: "currentMonth and previousMonth must both be valid YYYY-MM values.", noData: true };
  }

  const [current, previous] = await Promise.all([
    fetchSnapshot(docClient, tenantId, currentMonth),
    fetchSnapshot(docClient, tenantId, previousMonth)
  ]);

  if (!current && !previous) {
    return { error: `No data found for either ${currentMonth} or ${previousMonth}.`, noData: true };
  }

  const currentCost = current ? current.totalCost : 0;
  const previousCost = previous ? previous.totalCost : 0;
  const absoluteChange = currentCost - previousCost;
  const percentageChange = previousCost > 0 ? (absoluteChange / previousCost) * 100 : 0;

  return {
    currentMonth,
    previousMonth,
    currentCost,
    previousCost,
    absoluteChange,
    percentageChange,
    partialData: !current || !previous
  };
}

async function getCostTrend(docClient, tenantId, startMonth, endMonth) {
  if (!MONTH_RE.test(startMonth || "") || !MONTH_RE.test(endMonth || "")) {
    return { error: "startMonth and endMonth must both be valid YYYY-MM values.", noData: true };
  }

  // Generate list of months
  const months = [];
  let current = new Date(`${startMonth}-01T00:00:00Z`);
  const end = new Date(`${endMonth}-01T00:00:00Z`);

  // Guard against excessive queries or bad inputs
  if (current > end) {
    return { error: "startMonth must be before endMonth.", noData: true };
  }

  let iterations = 0;
  while (current <= end && iterations < 12) {
    const yyyy = current.getUTCFullYear();
    const mm = String(current.getUTCMonth() + 1).padStart(2, '0');
    months.push(`${yyyy}-${mm}`);
    current.setUTCMonth(current.getUTCMonth() + 1);
    iterations++;
  }

  if (current <= end) {
    console.warn("Trend requested more than 12 months. Truncating to 12 months.");
  }

  const results = await Promise.all(
    months.map(async (month) => {
      const data = await fetchSnapshot(docClient, tenantId, month);
      return { month, totalCost: data ? data.totalCost : 0, hasData: !!data };
    })
  );

  const anyData = results.some(r => r.hasData);
  if (!anyData) {
    return { error: `No cost data found for any month between ${startMonth} and ${endMonth}.`, noData: true };
  }

  return { trend: results };
}

async function getTopCostDrivers(docClient, tenantId, currentMonth, previousMonth) {
  if (!MONTH_RE.test(currentMonth || "") || !MONTH_RE.test(previousMonth || "")) {
    return { error: "currentMonth and previousMonth must both be valid YYYY-MM values.", noData: true };
  }

  const [current, previous] = await Promise.all([
    fetchSnapshot(docClient, tenantId, currentMonth),
    fetchSnapshot(docClient, tenantId, previousMonth)
  ]);

  if (!current && !previous) {
    return { error: `No data found for either ${currentMonth} or ${previousMonth}.`, noData: true };
  }

  const currentServices = current ? (current.services || {}) : {};
  const previousServices = previous ? (previous.services || {}) : {};

  const allServices = new Set([...Object.keys(currentServices), ...Object.keys(previousServices)]);
  const drivers = [];

  for (const service of allServices) {
    const currCost = currentServices[service] || 0;
    const prevCost = previousServices[service] || 0;
    const change = currCost - prevCost;

    // Only care about increases or decreases > $0.01
    if (Math.abs(change) > 0.01) {
      drivers.push({
        service,
        previousCost: prevCost,
        currentCost: currCost,
        absoluteChange: change
      });
    }
  }

  // Sort by highest absolute change (increase first)
  drivers.sort((a, b) => b.absoluteChange - a.absoluteChange);

  return {
    currentMonth,
    previousMonth,
    topIncreases: drivers.filter(d => d.absoluteChange > 0).slice(0, 5),
    topDecreases: drivers.filter(d => d.absoluteChange < 0).reverse().slice(0, 5),
    partialData: !current || !previous
  };
}

async function getDailySpend(docClient, tenantId, startDate, endDate) {
  if (!DATE_RE.test(startDate || "") || !DATE_RE.test(endDate || "")) {
    return { error: "startDate and endDate must both be valid YYYY-MM-DD values.", noData: true };
  }

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { error: "startDate and endDate must both be valid calendar dates.", noData: true };
  }
  if (start > end) {
    return { error: "startDate must be on or before endDate.", noData: true };
  }

  const rangeDays = Math.round((end - start) / 86400000) + 1;
  if (rangeDays > MAX_DAILY_RANGE_DAYS) {
    return { error: `That range is ${rangeDays} days — please ask for ${MAX_DAILY_RANGE_DAYS} days or fewer at a time.`, noData: true };
  }

  // Single range Query over the sortable DAY# keys — no Scan.
  const { Items } = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: "tenantId = :t AND snapshotId BETWEEN :start AND :end",
    ExpressionAttributeValues: {
      ":t": tenantId,
      ":start": `DAY#${startDate}`,
      ":end": `DAY#${endDate}`
    }
  }));

  const items = Items || [];
  if (items.length === 0) {
    return { error: `No cost data found between ${startDate} and ${endDate}.`, noData: true };
  }

  // Keep the payload lean: only attach a per-day service breakdown for short
  // ranges, so a longer trend request doesn't dump a wall of data on the model
  // (see AI-part/cloudpenny_ai_exact_implementation.md — aggregate/filter
  // before sending anything to the model, never the raw dataset).
  const includeServices = rangeDays <= 7;

  const days = items
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(item => {
      const day = { date: item.date, totalCost: item.totalCost || 0 };
      if (includeServices) {
        day.topServices = Object.entries(item.services || {})
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .slice(0, 3)
          .map(([service, cost]) => ({ service, cost }));
      }
      return day;
    });

  return { startDate, endDate, currency: "USD", days };
}

async function getTopOperationsForService(docClient, tenantId, month, service) {
  if (!MONTH_RE.test(month || "")) {
    return { error: `"${month}" is not a valid YYYY-MM month.`, noData: true };
  }
  if (!service || typeof service !== "string") {
    return { error: "service is required — call getSpendByService first to get the exact service name.", noData: true };
  }

  // Query every DAY# item for the month (bounded to <=31 items, no Scan) and
  // aggregate their already-bounded `items` arrays in memory. Cheaper and
  // simpler than maintaining a separate operation-level rollup in DynamoDB,
  // and reuses exactly the data saveSnapshot already wrote per day.
  const { Items } = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: "tenantId = :t AND begins_with(snapshotId, :prefix)",
    ExpressionAttributeValues: {
      ":t": tenantId,
      ":prefix": `DAY#${month}`
    }
  }));

  const dayItems = Items || [];
  if (dayItems.length === 0) {
    return { error: `No cost data found for month ${month}.`, noData: true };
  }

  const byOperation = new Map(); // `${operation}|${region}` -> { operation, region, cost, usageAmount }
  let serviceTotalCost = 0;
  let matchedAnyRow = false;

  for (const day of dayItems) {
    for (const row of day.items || []) {
      if (row.service !== service) continue;
      matchedAnyRow = true;
      serviceTotalCost += row.cost || 0;

      const key = `${row.operation}|${row.region}`;
      const existing = byOperation.get(key);
      if (existing) {
        existing.cost += row.cost || 0;
        existing.usageAmount += row.usageAmount || 0;
      } else {
        byOperation.set(key, { operation: row.operation, region: row.region, cost: row.cost || 0, usageAmount: row.usageAmount || 0 });
      }
    }
  }

  if (!matchedAnyRow) {
    return { error: `No operation-level data found for service "${service}" in ${month}. Double-check the exact service name via getSpendByService.`, noData: true };
  }

  const operations = [...byOperation.values()]
    .sort((a, b) => Math.abs(b.cost) - Math.abs(a.cost))
    .slice(0, 10)
    .map(o => ({ ...o, cost: round(o.cost), usageAmount: round(o.usageAmount) }));

  return {
    month,
    service,
    serviceTotalCost: round(serviceTotalCost),
    currency: "USD",
    topOperations: operations,
    note: operations.some(o => o.operation === "Other (aggregated)")
      ? "'Other (aggregated)' groups smaller operations that fell outside the top items tracked for some days — the individual operation names within it aren't available."
      : undefined
  };
}

async function getForecast(docClient, tenantId, month) {
  const targetMonth = (month && MONTH_RE.test(month)) ? month : new Date().toISOString().slice(0, 7);

  // Reuses the DAY# items saveSnapshot already wrote — the same rows the
  // dashboard's own forecast card is computed from — so the chat answer and
  // the dashboard figure can never disagree because they read different data.
  const { Items } = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: "tenantId = :t AND begins_with(snapshotId, :prefix)",
    ExpressionAttributeValues: { ":t": tenantId, ":prefix": `DAY#${targetMonth}` }
  }));

  const dayItems = Items || [];
  if (dayItems.length === 0) {
    return { error: `No cost data found for month ${targetMonth} yet, so a forecast can't be computed.`, noData: true };
  }

  const spendSoFar = dayItems.reduce((sum, d) => sum + (d.totalCost || 0), 0);
  const daysElapsed = dayItems.length;
  const [yyyy, mm] = targetMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();

  const forecast = (spendSoFar / daysElapsed) * daysInMonth;

  return {
    month: targetMonth,
    currency: "USD",
    spendSoFar: round(spendSoFar),
    daysElapsed,
    daysInMonth,
    forecast: round(forecast)
  };
}

async function getRecentAlerts(docClient, tenantId, limit) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);

  const { Items } = await docClient.send(new QueryCommand({
    TableName: ALERTS_TABLE,
    KeyConditionExpression: "tenantId = :t",
    ExpressionAttributeValues: { ":t": tenantId },
    ScanIndexForward: false, // newest first, same as the Alerts page
    Limit: cappedLimit
  }));

  const items = Items || [];
  if (items.length === 0) {
    return { alerts: [], note: "No cost anomaly alerts have been raised for this tenant." };
  }

  return {
    alerts: items.map(a => ({
      createdAt: a.createdAt,
      message: a.message,
      status: a.status
    }))
  };
}

const round = (n) => Math.round(n * 1e8) / 1e8;
