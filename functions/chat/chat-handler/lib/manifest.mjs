import { formatMonth } from "./period.mjs";

/**
 * The data-availability manifest.
 *
 * This is the single highest-leverage piece of grounding in the whole
 * handler. Without it the model has to GUESS which months and days have
 * data, guess wrong, receive a "no data" tool result, and then either give
 * up or burn another round trip guessing again — which is what the old
 * prompt's fallback rules existed to paper over.
 *
 * With it, the model knows before its first tool call exactly what exists,
 * so relative terms ("last month", "recently") resolve to a period that is
 * actually populated, and a genuine "we don't have that" becomes a fact it
 * can state immediately instead of a dead end it discovers by trial.
 *
 * Cost: three DynamoDB reads issued in parallel, none of which fetch the
 * heavy per-row `items` arrays.
 */

const TOP_SERVICES_LISTED = 12;
const REGIONS_LISTED = 10;

export async function buildManifest(repo, tenantId) {
  const [tenant, months, alertCount] = await Promise.all([
    repo.getTenant(tenantId),
    repo.listMonths(tenantId),
    repo.countAlerts(tenantId).catch(() => 0),
  ]);

  if (!tenant) return null;

  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const latest = sorted[sorted.length - 1] ?? null;

  const dates = latest ? Object.keys(latest.dailyTotals ?? {}).sort() : [];

  return {
    tenant,
    connected: tenant.connectionStatus === "VERIFIED",
    connectionStatus: tenant.connectionStatus ?? "NOT_CONNECTED",
    planTier: tenant.planTier ?? "free",
    email: tenant.email ?? null,
    currency: latest?.currency ?? "USD",
    months: sorted.map((m) => ({
      month: m.month,
      totalCost: m.totalCost ?? 0,
      dayCount: m.dayCount ?? Object.keys(m.dailyTotals ?? {}).length,
    })),
    earliestMonth: sorted[0]?.month ?? null,
    latestMonth: latest?.month ?? null,
    latestDateWithData: dates[dates.length - 1] ?? null,
    lastUpdated: latest?.updatedAt ?? null,
    topServices: rank(latest?.services).slice(0, TOP_SERVICES_LISTED),
    regions: rank(latest?.regions).slice(0, REGIONS_LISTED),
    alertCount,
  };
}

function rank(map) {
  return Object.entries(map ?? {})
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([key]) => key)
    .filter(Boolean);
}

/**
 * Renders the manifest as the <available_data> block of the system prompt.
 * Deliberately terse — this is injected on every single request, so every
 * line has to earn its tokens.
 */
export function renderManifest(manifest, today) {
  const lines = [`Today's date (UTC): ${today}`];

  if (!manifest.connected) {
    lines.push(
      `AWS connection: NOT CONNECTED (${manifest.connectionStatus}).`,
      "No cost data can exist for this tenant yet. Do not call cost tools; tell them to connect their AWS account first.",
    );
    return lines.join("\n");
  }

  lines.push(`AWS connection: connected. Plan: ${manifest.planTier}. Currency: ${manifest.currency}.`);

  if (!manifest.months.length) {
    lines.push(
      "Cost data available: NONE YET. The account is connected but no billing export has been processed.",
      "Do not call cost tools; say the first billing data has not arrived yet.",
    );
    return lines.join("\n");
  }

  lines.push(
    `Months with cost data: ${manifest.months.map((m) => m.month).join(", ")}`,
    `Most recent month: ${manifest.latestMonth} (${formatMonth(manifest.latestMonth)})`,
  );

  if (manifest.latestDateWithData) {
    lines.push(`Most recent day with data: ${manifest.latestDateWithData}`);
  }
  if (manifest.lastUpdated) {
    lines.push(`Data last refreshed: ${manifest.lastUpdated}`);
  }
  if (manifest.topServices.length) {
    lines.push(`Services in the most recent month (highest cost first): ${manifest.topServices.join(", ")}`);
  }
  if (manifest.regions.length) {
    lines.push(`Regions in use: ${manifest.regions.join(", ")}`);
  }
  lines.push(`Cost anomaly alerts on file: ${manifest.alertCount}`);
  lines.push(
    "Only the months listed above have data. Never query a month that is not listed, and never tell the user data is missing for a month that is listed without checking it first.",
  );

  return lines.join("\n");
}
