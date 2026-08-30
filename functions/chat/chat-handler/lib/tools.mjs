import { ValidationError } from "./errors.mjs";
import { queryCosts, DIMENSIONS, METRICS, SORTS } from "./queryCosts.mjs";
import {
  MONTH_RE,
  daysInMonth,
  monthOfDate,
  round,
  firstDayOf,
  lastDayOf,
} from "./period.mjs";

/**
 * The tool registry: the single source of truth for what Penny can do.
 *
 * The system prompt's capability list is generated from `capabilityLines`
 * below rather than written by hand, so the prompt can no longer drift out
 * of sync with the tools the way the old hand-maintained rule 8 and the
 * getSpendByService description did (they ended up contradicting each other
 * about whether a "top service" field existed).
 *
 * `createTools` takes its dependencies as arguments — a repository and the
 * current date — which is what lets the eval harness run the entire tool
 * surface against fixture data with no AWS involved.
 */
export function createTools({ repo, today, manifest }) {
  const tools = [
    queryCostsTool(repo, today),
    forecastTool(repo, today),
    alertsTool(repo),
    accountStatusTool(manifest),
  ];

  const byName = new Map(tools.map((t) => [t.definition.function.name, t]));

  return {
    definitions: tools.map((t) => t.definition),
    capabilityLines: tools.map((t) => `- ${t.definition.function.name}: ${t.capability}`),

    /**
     * Never throws. A bad call comes back as a structured tool result so the
     * model can correct itself on the next turn instead of the whole request
     * failing — validation errors carry the valid options in `hint`.
     */
    async dispatch(tenantId, name, args) {
      const tool = byName.get(name);
      if (!tool) {
        return {
          error: `There is no tool called "${name}".`,
          hint: `Available tools: ${[...byName.keys()].join(", ")}.`,
        };
      }

      try {
        return await tool.handler(tenantId, args ?? {});
      } catch (err) {
        if (err instanceof ValidationError) {
          return { error: err.message, ...(err.hint ? { hint: err.hint } : {}), invalidArguments: true };
        }
        console.error(JSON.stringify({ event: "tool_failed", tool: name, message: err?.message }));
        return { error: "That lookup failed unexpectedly. Do not retry it more than once." };
      }
    },
  };
}

// ── queryCosts ────────────────────────────────────────────────────────────

function queryCostsTool(repo, today) {
  return {
    capability:
      "any cost or usage breakdown — totals, by service, region, operation, or line item type (tax/credit/refund), per day or per month, filtered, and compared against another period",
    definition: {
      type: "function",
      function: {
        name: "queryCosts",
        description: [
          "The primary tool. Filters, groups and aggregates the tenant's AWS cost and usage data, optionally comparing against a second period. All arithmetic (totals, rankings, deltas, percentages, share of spend) is done server-side and returned in `summary` — use those figures directly, never recompute them.",
          "",
          "Examples:",
          '- Total spend last month: {"period":{"month":"2026-07"}}',
          '- Which service costs most: {"period":{"month":"2026-08"},"groupBy":["service"]}',
          '- Why is EC2 expensive: {"period":{"month":"2026-08"},"groupBy":["operation"],"filter":{"service":"AmazonEC2"}}',
          '- Spend by region: {"period":{"month":"2026-08"},"groupBy":["region"]}',
          '- How much is tax: {"period":{"month":"2026-08"},"groupBy":["lineItemType"]}',
          '- Six-month trend: {"period":{"lastNMonths":6},"groupBy":["month"]}',
          '- Yesterday / recent days: {"period":{"lastNDays":7},"groupBy":["day"]}',
          '- What grew the most: {"period":{"month":"2026-08"},"compareTo":{"month":"2026-07"},"groupBy":["service"],"sort":"change"}',
          '- Where does EC2 run: {"period":{"month":"2026-08"},"groupBy":["service","region"],"filter":{"service":"AmazonEC2"}}',
          '- EC2 usage quantity: {"metric":"usage","filter":{"service":"AmazonEC2"},"groupBy":["operation"]}',
        ].join("\n"),
        parameters: {
          type: "object",
          properties: {
            period: {
              type: "object",
              description:
                "The period to report on. Use exactly one shape. Defaults to the current month if omitted.",
              properties: {
                month: { type: "string", description: "A single month, YYYY-MM." },
                startMonth: { type: "string", description: "Range start month, YYYY-MM. Use with endMonth." },
                endMonth: { type: "string", description: "Range end month, YYYY-MM. Use with startMonth." },
                startDate: { type: "string", description: "Range start date, YYYY-MM-DD. Use with endDate." },
                endDate: { type: "string", description: "Range end date, YYYY-MM-DD. Use with startDate." },
                lastNDays: { type: "number", description: "The last N days including today." },
                lastNMonths: { type: "number", description: "The last N calendar months including this one." },
              },
            },
            compareTo: {
              type: "object",
              description:
                "An optional second period, same shapes as `period`. Adds previous/change/changePercent to every row and to summary.compare.",
              properties: {
                month: { type: "string" },
                startMonth: { type: "string" },
                endMonth: { type: "string" },
                startDate: { type: "string" },
                endDate: { type: "string" },
                lastNDays: { type: "number" },
                lastNMonths: { type: "number" },
              },
            },
            groupBy: {
              type: "array",
              description:
                "Up to 2 dimensions to break the figures down by. Omit for a single period total.",
              items: { type: "string", enum: DIMENSIONS },
            },
            filter: {
              type: "object",
              description: "Restricts the rows considered. Values must match the data exactly.",
              properties: {
                service: { type: "string", description: 'Exact CUR service code, e.g. "AmazonEC2".' },
                region: { type: "string", description: 'Exact region code, e.g. "us-east-1".' },
                lineItemType: { type: "string", description: 'e.g. "Usage", "Tax", "Credit", "Refund".' },
              },
            },
            metric: {
              type: "string",
              enum: METRICS,
              description:
                'Defaults to "cost". "usage" returns raw usage quantity and requires filter.service, because usage units differ per service.',
            },
            sort: {
              type: "string",
              enum: SORTS,
              description:
                'Row ordering. "value" (default) is highest cost/usage first. "change" is largest increase first and requires compareTo.',
            },
            limit: { type: "number", description: "Maximum rows returned. Defaults to 10, maximum 50." },
          },
        },
      },
    },
    handler: (tenantId, args) => queryCosts(repo, tenantId, args, { today }),
  };
}

// ── getForecast ───────────────────────────────────────────────────────────

function forecastTool(repo, today) {
  return {
    capability: "a projected month-end total for a month that is still in progress",
    definition: {
      type: "function",
      function: {
        name: "getForecast",
        description:
          "Projects total spend for a month from the days that already have data, using the same (spend so far / days elapsed) x days in month method as the dashboard's 'Forecasted Month' card, so the two can never disagree. Only meaningful for a month in progress.",
        parameters: {
          type: "object",
          properties: {
            month: { type: "string", description: "Month to forecast, YYYY-MM. Defaults to the current month." },
          },
        },
      },
    },
    handler: async (tenantId, { month }) => {
      const target = month ?? monthOfDate(today);
      if (!MONTH_RE.test(target)) {
        throw new ValidationError(`month must be in YYYY-MM format (got ${JSON.stringify(month)}).`);
      }

      const days = await repo.listDays(tenantId, firstDayOf(target), lastDayOf(target));

      let dailyTotals = days.map((d) => d.totalCost ?? 0);
      let source = "daily snapshots";

      if (!dailyTotals.length) {
        const rollup = await repo.getMonthSnapshot(tenantId, target);
        if (!rollup) {
          return {
            noData: true,
            error: `No cost data exists for ${target}, so no forecast can be computed.`,
          };
        }
        dailyTotals = Object.values(rollup.dailyTotals ?? {});
        source = "monthly rollup";
        if (!dailyTotals.length) {
          return { noData: true, error: `${target} has no day-level data, so no forecast can be computed.` };
        }
      }

      const spendSoFar = dailyTotals.reduce((sum, c) => sum + c, 0);
      const daysElapsed = dailyTotals.length;
      const totalDays = daysInMonth(target);

      return {
        month: target,
        currency: "USD",
        spendSoFar: round(spendSoFar),
        daysElapsed,
        daysInMonth: totalDays,
        forecast: round((spendSoFar / daysElapsed) * totalDays),
        source,
      };
    },
  };
}

// ── getRecentAlerts ───────────────────────────────────────────────────────

function alertsTool(repo) {
  return {
    capability: "cost anomaly alerts that have actually been raised for this tenant",
    definition: {
      type: "function",
      function: {
        name: "getRecentAlerts",
        description:
          "Returns AWS Cost Anomaly Detection alerts already raised for this tenant, newest first. Use this for 'any unusual spending', 'any anomalies', 'what alerts have I had'. This reports real raised alerts — it is not a period comparison, so do not use queryCosts for it.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum alerts to return. Defaults to 5, maximum 20." },
          },
        },
      },
    },
    handler: async (tenantId, { limit }) => {
      const capped = Math.min(Math.max(Number(limit) || 5, 1), 20);
      const items = await repo.listAlerts(tenantId, capped);

      if (!items.length) {
        return { alerts: [], note: "No cost anomaly alerts have ever been raised for this tenant." };
      }

      return {
        alerts: items.map((a) => ({ createdAt: a.createdAt, message: a.message, status: a.status })),
      };
    },
  };
}

// ── getAccountStatus ──────────────────────────────────────────────────────

function accountStatusTool(manifest) {
  return {
    capability:
      "account state — whether AWS is connected, which plan they are on, how fresh the data is, and how much of today's refresh quota is left",
    definition: {
      type: "function",
      function: {
        name: "getAccountStatus",
        description:
          "Returns this tenant's CloudPenny account state: AWS connection status, plan tier, when their cost data was last refreshed, which months are stored, and their remaining daily data-refresh quota. Use for 'is my account connected', 'how current is this data', 'how many refreshes do I have left'.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async () => {
      const tenant = manifest.tenant;
      const quota = tenant.dailyRefreshQuota ?? 1;
      const todayUtc = new Date().toISOString().slice(0, 10);
      const used = tenant.lastRefreshDate === todayUtc ? (tenant.dailyRefreshesUsed ?? 0) : 0;

      return {
        connectionStatus: manifest.connectionStatus,
        connected: manifest.connected,
        planTier: manifest.planTier,
        // The AWS account number is deliberately not returned — it is not
        // needed to answer any question the user can ask here, and keeping it
        // out of the model context keeps it out of the provider's logs.
        awsAccountConnected: Boolean(tenant.awsAccountId),
        monthsStored: manifest.months.map((m) => m.month),
        latestDateWithData: manifest.latestDateWithData,
        dataLastRefreshed: manifest.lastUpdated,
        dailyRefreshQuota: quota,
        dailyRefreshesUsed: used,
        dailyRefreshesRemaining: Math.max(quota - used, 0),
        alertCount: manifest.alertCount,
      };
    },
  };
}
