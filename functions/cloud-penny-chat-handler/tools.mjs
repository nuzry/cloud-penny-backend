import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "cloudpenny-snapshots-dev";

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

      default:
        throw new Error(`Tool ${toolName} not found.`);
    }
  } catch (error) {
    console.error(`[TOOL ERROR] ${toolName}:`, error);
    return { error: error.message };
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
  const data = await fetchSnapshot(docClient, tenantId, month);
  if (!data) return { error: `No cost data found for month ${month}.` };
  
  return {
    month,
    totalCost: data.totalCost,
    currency: data.currency || "USD"
  };
}

async function getSpendByService(docClient, tenantId, month) {
  const data = await fetchSnapshot(docClient, tenantId, month);
  if (!data) return { error: `No cost data found for month ${month}.` };
  
  return {
    month,
    services: data.services
  };
}

async function compareSpendPeriods(docClient, tenantId, currentMonth, previousMonth) {
  const [current, previous] = await Promise.all([
    fetchSnapshot(docClient, tenantId, currentMonth),
    fetchSnapshot(docClient, tenantId, previousMonth)
  ]);
  
  if (!current && !previous) return { error: `No data found for both ${currentMonth} and ${previousMonth}.` };
  
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
    percentageChange
  };
}

async function getCostTrend(docClient, tenantId, startMonth, endMonth) {
  // Generate list of months
  const months = [];
  let current = new Date(`${startMonth}-01T00:00:00Z`);
  const end = new Date(`${endMonth}-01T00:00:00Z`);
  
  // Guard against excessive queries or bad inputs
  if (current > end) return { error: "startMonth must be before endMonth." };
  
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

  const results = [];
  for (const month of months) {
    const data = await fetchSnapshot(docClient, tenantId, month);
    results.push({
      month,
      totalCost: data ? data.totalCost : 0
    });
  }
  
  return { trend: results };
}

async function getTopCostDrivers(docClient, tenantId, currentMonth, previousMonth) {
  const [current, previous] = await Promise.all([
    fetchSnapshot(docClient, tenantId, currentMonth),
    fetchSnapshot(docClient, tenantId, previousMonth)
  ]);
  
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
    topDecreases: drivers.filter(d => d.absoluteChange < 0).reverse().slice(0, 5)
  };
}
