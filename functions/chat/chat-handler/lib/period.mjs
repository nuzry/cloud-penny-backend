import { ValidationError } from "./errors.mjs";

/**
 * Calendar arithmetic and period resolution.
 *
 * Every date in this system is a UTC calendar string (YYYY-MM-DD / YYYY-MM),
 * matching the CUR `usage_date` and the DynamoDB `DAY#`/`MONTH#` sort keys.
 * Nothing here uses local time, so a Lambda running in any region resolves
 * "yesterday" identically.
 */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Bounds on how much data one question may pull. A DAY# item carries a
// bounded-but-not-tiny `items` array, so an unbounded range is both a cost
// and a latency problem.
export const MAX_PERIOD_DAYS = 400;
export const MAX_PERIOD_MONTHS = 13;

export const round = (n) => Math.round(n * 1e8) / 1e8;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const isoDate = (d) => d.toISOString().slice(0, 10);

export const monthOfDate = (date) => date.slice(0, 7);

export function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const firstDayOf = (month) => `${month}-01`;

export const lastDayOf = (month) =>
  `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;

export function addMonths(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDate(d);
}

export function monthsBetween(startMonth, endMonth) {
  const months = [];
  let cursor = startMonth;
  while (cursor <= endMonth && months.length <= MAX_PERIOD_MONTHS) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

export function daysBetweenInclusive(startDate, endDate) {
  const ms = new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`);
  return Math.round(ms / 86400000) + 1;
}

export function formatMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/**
 * Turns any of the accepted period shapes into a single concrete
 * { startDate, endDate, months, wholeMonths, label } envelope.
 *
 * `wholeMonths` is what lets the query engine read the cheap MONTH# rollups
 * instead of every DAY# item: it is true only when the range starts on the
 * 1st of its first month and ends on the last calendar day of its last one.
 *
 * Throws ValidationError (never a bare Error) so the caller can hand the
 * message straight back to the model as a correctable tool result.
 */
export function resolvePeriod(period, today) {
  const spec = period ?? {};
  const currentMonth = monthOfDate(today);

  let startDate;
  let endDate;

  if (spec.month !== undefined) {
    assertMonth(spec.month, "month");
    startDate = firstDayOf(spec.month);
    endDate = lastDayOf(spec.month);
  } else if (spec.startMonth !== undefined || spec.endMonth !== undefined) {
    assertMonth(spec.startMonth, "startMonth");
    assertMonth(spec.endMonth, "endMonth");
    if (spec.startMonth > spec.endMonth) {
      throw new ValidationError("startMonth must not be after endMonth.");
    }
    startDate = firstDayOf(spec.startMonth);
    endDate = lastDayOf(spec.endMonth);
  } else if (spec.startDate !== undefined || spec.endDate !== undefined) {
    assertDate(spec.startDate, "startDate");
    assertDate(spec.endDate, "endDate");
    if (spec.startDate > spec.endDate) {
      throw new ValidationError("startDate must not be after endDate.");
    }
    startDate = spec.startDate;
    endDate = spec.endDate;
  } else if (spec.lastNDays !== undefined) {
    const n = asPositiveInt(spec.lastNDays, "lastNDays");
    // Inclusive of today, so lastNDays:1 is today and lastNDays:7 is the
    // last full week including today.
    endDate = today;
    startDate = addDays(today, -(n - 1));
  } else if (spec.lastNMonths !== undefined) {
    const n = asPositiveInt(spec.lastNMonths, "lastNMonths");
    // Inclusive of the current (partial) month, matching how people say
    // "the last 6 months".
    startDate = firstDayOf(addMonths(currentMonth, -(n - 1)));
    endDate = lastDayOf(currentMonth);
  } else {
    // No period given at all: the current month is what a dashboard user
    // means by default, and it is always the month most likely to have data.
    startDate = firstDayOf(currentMonth);
    endDate = lastDayOf(currentMonth);
  }

  const dayCount = daysBetweenInclusive(startDate, endDate);
  if (dayCount > MAX_PERIOD_DAYS) {
    throw new ValidationError(
      `That period spans ${dayCount} days, which is more than the ${MAX_PERIOD_DAYS}-day maximum.`,
      `Ask about a shorter range, or use groupBy:["month"] over at most ${MAX_PERIOD_MONTHS} months.`,
    );
  }

  const months = monthsBetween(monthOfDate(startDate), monthOfDate(endDate));
  if (months.length > MAX_PERIOD_MONTHS) {
    throw new ValidationError(
      `That period spans ${months.length} months, which is more than the ${MAX_PERIOD_MONTHS}-month maximum.`,
    );
  }

  const wholeMonths =
    startDate === firstDayOf(months[0]) &&
    endDate === lastDayOf(months[months.length - 1]);

  return { startDate, endDate, months, wholeMonths, label: buildLabel(startDate, endDate, months, wholeMonths) };
}

function buildLabel(startDate, endDate, months, wholeMonths) {
  if (wholeMonths && months.length === 1) return formatMonth(months[0]);
  if (wholeMonths) return `${formatMonth(months[0])} to ${formatMonth(months[months.length - 1])}`;
  if (startDate === endDate) return startDate;
  return `${startDate} to ${endDate}`;
}

function assertMonth(value, field) {
  if (!MONTH_RE.test(value ?? "")) {
    throw new ValidationError(
      `${field} must be a month in YYYY-MM format (got ${JSON.stringify(value)}).`,
      "Example: \"2026-08\".",
    );
  }
}

function assertDate(value, field) {
  if (!DATE_RE.test(value ?? "")) {
    throw new ValidationError(
      `${field} must be a date in YYYY-MM-DD format (got ${JSON.stringify(value)}).`,
      "Example: \"2026-08-14\".",
    );
  }
  if (Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new ValidationError(`${field} is not a real calendar date (got ${value}).`);
  }
}

function asPositiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`${field} must be a whole number of 1 or more (got ${JSON.stringify(value)}).`);
  }
  return n;
}
