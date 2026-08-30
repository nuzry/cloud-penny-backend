import { ValidationError } from "./errors.mjs";
import {
  monthOfDate,
  resolvePeriod,
  round,
  firstDayOf,
  lastDayOf,
} from "./period.mjs";

/**
 * One composable query primitive over the tenant's cost data.
 *
 * This replaces eight hand-written, near-identical tools (monthly total,
 * by service, by region, daily, trend, compare, drivers, operations) with a
 * single filter/group/aggregate/compare operation — and in doing so exposes
 * dimensions that previously had no tool at all: line item type (tax,
 * credits, refunds), usage quantity, and cross-dimension breakdowns such as
 * service x region.
 *
 * Two invariants hold throughout:
 *
 *  1. ARITHMETIC IS DONE HERE, NEVER BY THE MODEL. Every ranking, delta,
 *     percentage and share is computed and labelled before it leaves this
 *     function. The model's only job is phrasing.
 *
 *  2. FIDELITY IS REPORTED, NOT ASSUMED. `services`, `regions` and
 *     `lineItemTypes` on a DAY# item are exact (summed before truncation),
 *     but the per-row `items` array keeps only the top rows verbatim and
 *     folds the tail into "Other (aggregated)" with its operation and region
 *     erased. Any result that could be affected by that tail comes back with
 *     `approximate: true` and a note quantifying how much spend it covers.
 */

export const DIMENSIONS = ["service", "region", "operation", "lineItemType", "day", "month"];
export const METRICS = ["cost", "usage"];
export const SORTS = ["value", "change"];

const MAX_GROUP_DIMENSIONS = 2;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const UNATTRIBUTED = "(unattributed)";
const OTHER_OPERATION = "Other (aggregated)";

/** Dimensions readable straight from a DAY# item's exact pre-aggregated maps. */
const EXACT_MAP_DIMENSIONS = new Set(["service", "region", "lineItemType", "day", "month"]);

/** Dimensions whose accuracy depends on the truncated `items` tail. */
const TAIL_SENSITIVE = new Set(["region", "operation"]);

export async function queryCosts(repo, tenantId, rawSpec, { today }) {
  const spec = validateSpec(rawSpec);
  const period = resolvePeriod(spec.period, today);

  const needsRows = requiresRowLevelData(spec);
  const data = await loadPeriod(repo, tenantId, period, needsRows);

  if (!data.hasAnyData) {
    const months = await repo.listMonths(tenantId);
    return {
      noData: true,
      period: { ...periodEnvelope(period) },
      error: `No cost data exists for ${period.label}.`,
      availableMonths: months.map((m) => m.month).sort(),
      hint: months.length
        ? "Re-run the query against one of availableMonths — do not guess a different period."
        : "This tenant has no cost data at all yet; their AWS account may not be connected or their first billing export has not landed.",
    };
  }

  const current = aggregate(data, spec, period);

  let compare = null;
  let comparePeriod = null;
  if (spec.compareTo) {
    comparePeriod = resolvePeriod(spec.compareTo, today);
    const compareData = await loadPeriod(repo, tenantId, comparePeriod, needsRows);
    compare = compareData.hasAnyData ? aggregate(compareData, spec, comparePeriod) : emptyAggregate();
  }

  return buildResult({ spec, period, comparePeriod, current, compare, data });
}

// ── Validation ────────────────────────────────────────────────────────────

function validateSpec(raw) {
  const spec = raw ?? {};

  const metric = spec.metric ?? "cost";
  if (!METRICS.includes(metric)) {
    throw new ValidationError(
      `metric must be one of ${METRICS.join(", ")} (got ${JSON.stringify(spec.metric)}).`,
    );
  }

  const groupBy = spec.groupBy ?? [];
  if (!Array.isArray(groupBy)) {
    throw new ValidationError("groupBy must be an array of dimension names.", `Valid dimensions: ${DIMENSIONS.join(", ")}.`);
  }
  if (groupBy.length > MAX_GROUP_DIMENSIONS) {
    throw new ValidationError(
      `groupBy accepts at most ${MAX_GROUP_DIMENSIONS} dimensions (got ${groupBy.length}).`,
    );
  }
  for (const dim of groupBy) {
    if (!DIMENSIONS.includes(dim)) {
      throw new ValidationError(
        `"${dim}" is not a groupBy dimension.`,
        `Valid dimensions: ${DIMENSIONS.join(", ")}.`,
      );
    }
  }
  if (new Set(groupBy).size !== groupBy.length) {
    throw new ValidationError("groupBy must not repeat a dimension.");
  }

  const filter = {};
  for (const [key, value] of Object.entries(spec.filter ?? {})) {
    if (!["service", "region", "lineItemType"].includes(key)) {
      throw new ValidationError(
        `"${key}" is not a filter field.`,
        "Valid filter fields: service, region, lineItemType.",
      );
    }
    if (value !== undefined && value !== null && value !== "") {
      filter[key] = String(value);
    }
  }

  // Usage quantities are in each service's own CUR unit — GB, vCPU-hours,
  // requests — so summing them across services produces a meaningless
  // number. Requiring a service filter makes that impossible by construction
  // rather than by asking the prompt to police it.
  if (metric === "usage" && !filter.service) {
    throw new ValidationError(
      "metric \"usage\" requires filter.service, because usage units differ per service and cannot be summed across them.",
      "Example: { metric: \"usage\", filter: { service: \"AmazonEC2\" }, groupBy: [\"operation\"] }.",
    );
  }

  const sort = spec.sort ?? "value";
  if (!SORTS.includes(sort)) {
    throw new ValidationError(`sort must be one of ${SORTS.join(", ")} (got ${JSON.stringify(spec.sort)}).`);
  }
  if (sort === "change" && !spec.compareTo) {
    throw new ValidationError(
      "sort \"change\" requires compareTo, since there is nothing to compare against otherwise.",
    );
  }

  let limit = spec.limit === undefined ? DEFAULT_LIMIT : Number(spec.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(`limit must be a whole number of 1 or more (got ${JSON.stringify(spec.limit)}).`);
  }
  limit = Math.min(limit, MAX_LIMIT);

  return { metric, groupBy, filter, sort, limit, period: spec.period, compareTo: spec.compareTo };
}

function requiresRowLevelData({ metric, groupBy, filter }) {
  if (metric === "usage") return true;
  if (groupBy.includes("operation")) return true;
  if (groupBy.length > 1) return true;
  if (Object.keys(filter).length > 0) return true;
  return !groupBy.every((dim) => EXACT_MAP_DIMENSIONS.has(dim));
}

// ── Loading ───────────────────────────────────────────────────────────────

/**
 * Reads DAY# items first, exactly as the dashboard does, so a chat answer can
 * never disagree with the dashboard by having read a different source. Months
 * with no DAY# coverage fall back to their MONTH# rollup, which carries less
 * detail — recorded in `fallbackMonths` so the caller can say so.
 */
async function loadPeriod(repo, tenantId, period, needsRows) {
  const days = await repo.listDays(tenantId, period.startDate, period.endDate, { includeItems: needsRows });

  const coveredMonths = new Set(days.map((d) => monthOfDate(d.date)));
  const missing = period.months.filter((m) => !coveredMonths.has(m));

  const fallbackMonths = [];
  if (missing.length) {
    const rollups = await Promise.all(missing.map((m) => repo.getMonthSnapshot(tenantId, m)));
    rollups.forEach((rollup, i) => {
      if (rollup) fallbackMonths.push({ ...rollup, month: missing[i] });
    });
  }

  return {
    days,
    fallbackMonths,
    hasAnyData: days.length > 0 || fallbackMonths.length > 0,
    currency: days[0]?.currency ?? fallbackMonths[0]?.currency ?? "USD",
  };
}

// ── Aggregation ───────────────────────────────────────────────────────────

function emptyAggregate() {
  return { groups: new Map(), total: 0, periodTotal: 0, otherTailCost: 0, degradedMonths: [] };
}

function aggregate(data, spec, period) {
  const out = emptyAggregate();
  const { metric, groupBy, filter } = spec;
  const useRows = requiresRowLevelData(spec);

  for (const day of data.days) {
    out.periodTotal += day.totalCost ?? 0;

    if (useRows) {
      accumulateRows(out, day, spec);
    } else {
      accumulateMaps(out, day, groupBy, metric);
    }
  }

  for (const rollup of data.fallbackMonths) {
    accumulateRollup(out, rollup, spec, period);
  }

  return out;
}

/** Exact path: read the pre-truncation maps a DAY# item already carries. */
function accumulateMaps(out, day, groupBy, metric) {
  if (metric !== "cost") return;

  if (groupBy.length === 0) {
    out.total += day.totalCost ?? 0;
    return;
  }

  const dim = groupBy[0];

  if (dim === "day") {
    addGroup(out, { day: day.date }, day.totalCost ?? 0);
    return;
  }
  if (dim === "month") {
    addGroup(out, { month: monthOfDate(day.date) }, day.totalCost ?? 0);
    return;
  }

  const map =
    dim === "service" ? day.services :
    dim === "region" ? day.regions :
    day.lineItemTypes;

  for (const [rawKey, cost] of Object.entries(map ?? {})) {
    const key = dim === "region" && !rawKey ? UNATTRIBUTED : rawKey;
    addGroup(out, { [dim]: key }, cost ?? 0);
  }
}

/** Row path: needed for operations, usage, filters and cross-dimension breakdowns. */
function accumulateRows(out, day, { metric, groupBy, filter }) {
  for (const row of day.items ?? []) {
    const isTail = row.operation === OTHER_OPERATION;
    if (isTail) out.otherTailCost += row.cost ?? 0;

    if (filter.service && row.service !== filter.service) continue;
    if (filter.lineItemType && row.lineItemType !== filter.lineItemType) continue;
    if (filter.region && (row.region || UNATTRIBUTED) !== filter.region) continue;

    const value = metric === "usage" ? (row.usageAmount ?? 0) : (row.cost ?? 0);

    if (groupBy.length === 0) {
      out.total += value;
      continue;
    }

    const fields = {};
    for (const dim of groupBy) {
      fields[dim] =
        dim === "day" ? day.date :
        dim === "month" ? monthOfDate(day.date) :
        dim === "region" ? (row.region || UNATTRIBUTED) :
        row[dim] ?? "Unknown";
    }
    addGroup(out, fields, value);
  }
}

/**
 * A month with no DAY# items can still answer coarse questions from its
 * MONTH# rollup. Anything the rollup cannot express (operations, usage, line
 * item types, filters) is recorded in `degradedMonths` and reported.
 */
function accumulateRollup(out, rollup, { metric, groupBy, filter }, period) {
  const month = rollup.month;
  const dailyTotals = rollup.dailyTotals ?? {};
  const inRange = ([date]) => date >= period.startDate && date <= period.endDate;
  const rangedDays = Object.entries(dailyTotals).filter(inRange);

  const rangedTotal = rangedDays.reduce((sum, [, cost]) => sum + (cost ?? 0), 0);
  out.periodTotal += rangedDays.length ? rangedTotal : (rollup.totalCost ?? 0);

  const wholeMonthInRange =
    period.startDate <= firstDayOf(month) && period.endDate >= lastDayOf(month);

  const canAnswer =
    metric === "cost" &&
    Object.keys(filter).length === 0 &&
    groupBy.length <= 1 &&
    (groupBy.length === 0 ||
      groupBy[0] === "day" ||
      groupBy[0] === "month" ||
      (wholeMonthInRange && (groupBy[0] === "service" || groupBy[0] === "region")));

  if (!canAnswer) {
    out.degradedMonths.push(month);
    return;
  }

  if (groupBy.length === 0) {
    out.total += rangedDays.length ? rangedTotal : (rollup.totalCost ?? 0);
    return;
  }

  const dim = groupBy[0];

  if (dim === "day") {
    for (const [date, cost] of rangedDays) addGroup(out, { day: date }, cost ?? 0);
    return;
  }
  if (dim === "month") {
    addGroup(out, { month }, rangedDays.length ? rangedTotal : (rollup.totalCost ?? 0));
    return;
  }

  const map = dim === "service" ? rollup.services : rollup.regions;
  for (const [rawKey, cost] of Object.entries(map ?? {})) {
    const key = dim === "region" && !rawKey ? UNATTRIBUTED : rawKey;
    addGroup(out, { [dim]: key }, cost ?? 0);
  }
}

function addGroup(out, fields, value) {
  const id = Object.values(fields).join(" | ");
  const existing = out.groups.get(id);
  if (existing) {
    existing.value += value;
  } else {
    out.groups.set(id, { ...fields, value });
  }
  out.total += value;
}

// ── Result assembly ───────────────────────────────────────────────────────

function periodEnvelope(period) {
  return {
    label: period.label,
    startDate: period.startDate,
    endDate: period.endDate,
  };
}

function buildResult({ spec, period, comparePeriod, current, compare, data }) {
  const { metric, groupBy, filter, sort, limit } = spec;
  const valueKey = metric === "usage" ? "usageAmount" : "cost";

  const joined = [...current.groups.values()].map((g) => ({ ...g }));

  if (compare) {
    const previousById = new Map([...compare.groups.entries()].map(([id, g]) => [id, g.value]));
    const seen = new Set();

    for (const group of joined) {
      const id = groupId(group, groupBy);
      seen.add(id);
      group.previous = round(previousById.get(id) ?? 0);
      group.change = round(group.value - (previousById.get(id) ?? 0));
      group.changePercent = percentChange(previousById.get(id) ?? 0, group.value);
    }

    // Groups that existed only in the earlier period — a service that was
    // switched off is exactly the kind of thing a cost question is about.
    for (const [id, group] of compare.groups.entries()) {
      if (seen.has(id)) continue;
      joined.push({
        ...group,
        value: 0,
        previous: round(group.value),
        change: round(-group.value),
        changePercent: percentChange(group.value, 0),
      });
    }
  }

  const sorted = [...joined].sort((a, b) =>
    sort === "change" ? (b.change ?? 0) - (a.change ?? 0) : Math.abs(b.value) - Math.abs(a.value));

  const total = round(current.total);
  const rows = sorted.slice(0, limit).map((g) => {
    const row = {};
    for (const dim of groupBy) row[dim] = g[dim];
    row[valueKey] = round(g.value);
    if (total !== 0) row.share = round((g.value / total) * 100);
    if (compare) {
      row.previous = g.previous;
      row.change = g.change;
      row.changePercent = g.changePercent;
    }
    return row;
  });

  const notes = [];
  const tailTouched =
    current.otherTailCost !== 0 &&
    (groupBy.some((d) => TAIL_SENSITIVE.has(d)) || filter.region !== undefined);

  if (tailTouched) {
    notes.push(
      `${round(current.otherTailCost)} ${data.currency} of spend in this period sits in an aggregated tail where the individual operation and region were not retained, so operation- and region-level figures here are close but not exact.`,
    );
  }
  if (current.degradedMonths.length) {
    notes.push(
      `${current.degradedMonths.join(", ")} only has a coarse monthly rollup stored, so it could not be broken down this way and is excluded from the grouped figures below (its spend is still counted in periodTotal).`,
    );
  }
  if (metric === "usage") {
    notes.push("Usage amounts are in the service's own CUR unit; the unit name is not retained in the snapshot, so do not state a unit.");
  }

  const result = {
    period: periodEnvelope(period),
    metric,
    groupBy,
    currency: data.currency,
    ...(Object.keys(filter).length ? { filter } : {}),
    rows,
    summary: {
      total,
      periodTotal: round(current.periodTotal),
      groupCount: joined.length,
      returned: rows.length,
      daysWithData: data.days.length,
      approximate: tailTouched || current.degradedMonths.length > 0,
    },
    ...(notes.length ? { notes } : {}),
  };

  // `top` always means "highest value", even when `rows` is ordered by change,
  // so the model never has to work out which ordering it is looking at.
  if (groupBy.length && joined.length) {
    const highest = [...joined].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
    result.summary.top = summarise(highest, groupBy, valueKey, { compare: Boolean(compare), total });
  }

  if (compare) {
    const previousTotal = round(compare.total);
    const byChange = [...joined].sort((a, b) => (b.change ?? 0) - (a.change ?? 0));
    const increases = byChange.filter((g) => (g.change ?? 0) > 0);
    const decreases = byChange.filter((g) => (g.change ?? 0) < 0);

    result.comparedTo = periodEnvelope(comparePeriod);
    result.summary.compare = {
      previousTotal,
      change: round(total - previousTotal),
      changePercent: percentChange(previousTotal, total),
      ...(groupBy.length
        ? {
            biggestIncrease: increases.length
              ? summarise(increases[0], groupBy, valueKey, { compare: true, total })
              : null,
            biggestDecrease: decreases.length
              ? summarise(decreases[decreases.length - 1], groupBy, valueKey, { compare: true, total })
              : null,
          }
        : {}),
    };
  }

  return result;
}

function summarise(group, groupBy, valueKey, { compare, total } = {}) {
  const out = {};
  for (const dim of groupBy) out[dim] = group[dim];
  out[valueKey] = round(group.value);
  if (total) out.share = round((group.value / total) * 100);
  if (compare) {
    out.previous = group.previous;
    out.change = group.change;
    out.changePercent = group.changePercent;
  }
  return out;
}

function groupId(group, groupBy) {
  return groupBy.map((dim) => group[dim]).join(" | ");
}

/**
 * Percentage change with the divide-by-zero case handled explicitly rather
 * than silently reported as 0% — "spend appeared from nothing" and "spend did
 * not change" are very different answers.
 */
function percentChange(previous, currentValue) {
  if (previous === 0) return currentValue === 0 ? 0 : null;
  return round(((currentValue - previous) / Math.abs(previous)) * 100);
}
