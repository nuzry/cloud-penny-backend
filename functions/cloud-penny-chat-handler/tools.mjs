import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "cloudpenny-snapshots-dev";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAILY_RANGE_DAYS = 31; // keeps the range query and Bedrock payload small

// --- TOOL SCHEMAS ---

export const toolDefinitions = [
  {
    toolSpec: {
      name: "getMonthlySpend",
      description: "Returns the total AWS expenditure for a specific month.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            month: { type: "string", description: "The month to query in YYYY-MM format, e.g., '2026-08'" }
          },
          required: ["month"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "getSpendByService",
      description: "Returns the breakdown of AWS costs by individual services for a specific month.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            month: { type: "string", description: "The month to query in YYYY-MM format, e.g., '2026-08'" }
          },
          required: ["month"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "compareSpendPeriods",
      description: "Compares the total AWS spend between two specific months and returns the absolute and percentage change.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            currentMonth: { type: "string", description: "The more recent month in YYYY-MM format, e.g., '2026-08'" },
            previousMonth: { type: "string", description: "The older month in YYYY-MM format, e.g., '2026-07'" }
          },
          required: ["currentMonth", "previousMonth"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "getCostTrend",
      description: "Returns an array of total monthly spends over a period of time to show a trend. Do not use this if they only ask for two specific months.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            startMonth: { type: "string", description: "The starting month in YYYY-MM format." },
            endMonth: { type: "string", description: "The ending month in YYYY-MM format." }
          },
          required: ["startMonth", "endMonth"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "getTopCostDrivers",
      description: "Compares the service-level costs between two months and identifies which services increased the most.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            currentMonth: { type: "string", description: "The more recent month in YYYY-MM format." },
            previousMonth: { type: "string", description: "The older month in YYYY-MM format." }
          },
          required: ["currentMonth", "previousMonth"]
        }
      }
    }
  },
  {
    toolSpec: {
      name: "getDailySpend",
      description: "Returns day-by-day AWS spend totals for a specific date range (max 31 days). Use this for questions about a specific day (e.g. yesterday) or a short recent window, rather than a whole month.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            startDate: { type: "string", description: "Start date in YYYY-MM-DD format, inclusive." },
            endDate: { type: "string", description: "End date in YYYY-MM-DD format, inclusive." }
          },
          required: ["startDate", "endDate"]
        }
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

      case "compareSpendPeriods":
        return await compareSpendPeriods(docClient, tenantId, input.currentMonth, input.previousMonth);

      case "getCostTrend":
        return await getCostTrend(docClient, tenantId, input.startMonth, input.endMonth);

      case "getTopCostDrivers":
        return await getTopCostDrivers(docClient, tenantId, input.currentMonth, input.previousMonth);

      case "getDailySpend":
        return await getDailySpend(docClient, tenantId, input.startDate, input.endDate);

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

  return {
    month,
    services: data.services
  };
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
  // ranges, so a longer trend request doesn't dump a wall of data on Bedrock
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
