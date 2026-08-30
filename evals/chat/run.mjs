#!/usr/bin/env node
/**
 * Chat evaluation harness.
 *
 *   npm run eval:chat
 *
 * Runs every golden question through the real model against the synthetic
 * tenant in fixtures.mjs — the same agent loop, tools, query engine and
 * prompt the Lambda runs, with only the repository swapped for fixtures.
 * No AWS, no real tenant data.
 *
 * It scores three things the unit tests cannot:
 *
 *   tool selection    — did it reach for the right lookup
 *   numeric accuracy  — do the figures it states match the data
 *   false "no data"   — did it claim data was missing when it was present
 *
 * Use it as a regression gate: change the prompt, a tool description or the
 * model, re-run, and see what moved. Exits non-zero below --threshold.
 *
 * Requires GROQ_API_KEY. Optional: GROQ_MODEL_ID, --concurrency, --filter,
 * --threshold, --verbose.
 */

import { createFixtureRepository, TODAY } from "./fixtures.mjs";
import { questions } from "./questions.mjs";
import { buildManifest } from "../../functions/chat/chat-handler/lib/manifest.mjs";
import { createTools } from "../../functions/chat/chat-handler/lib/tools.mjs";
import { GroqProvider } from "../../functions/chat/chat-handler/lib/providers.mjs";
import { runAgent } from "../../functions/chat/chat-handler/lib/agent.mjs";
import { buildSystemPrompt } from "../../functions/chat/chat-handler/prompt.mjs";

const args = parseArgs(process.argv.slice(2));
const MODEL = process.env.GROQ_MODEL_ID || "openai/gpt-oss-120b";
const THRESHOLD = Number(args.threshold ?? 0.8);
const CONCURRENCY = Number(args.concurrency ?? 3);

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is not set. Export it and re-run:\n  GROQ_API_KEY=... npm run eval:chat");
  process.exit(1);
}

const selected = args.filter
  ? questions.filter((q) => q.id.includes(args.filter) || q.tags.includes(args.filter))
  : questions;

if (!selected.length) {
  console.error(`No questions matched --filter=${args.filter}`);
  process.exit(1);
}

console.log(`\nPenny evaluation — ${selected.length} question(s), model ${MODEL}\n`);

const results = await mapWithConcurrency(selected, CONCURRENCY, evaluate);
report(results);

// ── One question ──────────────────────────────────────────────────────────

async function evaluate(spec) {
  const repo = createFixtureRepository();
  const manifest = await buildManifest(repo, "tenant-fixture");
  const tools = createTools({ repo, today: TODAY, manifest });

  const provider = new GroqProvider({ apiKey: process.env.GROQ_API_KEY, model: MODEL });
  const startedAt = Date.now();

  try {
    const { reply, trace, usage, stopReason } = await runAgent({
      provider,
      systemPrompt: buildSystemPrompt({ manifest, capabilityLines: tools.capabilityLines, today: TODAY }),
      message: spec.question,
      tools,
      tenantId: "tenant-fixture",
      log: () => {},
    });

    const called = [...new Set(trace.map((t) => t.tool))];

    return {
      spec,
      reply,
      called,
      ms: Date.now() - startedAt,
      toolCalls: trace.length,
      tokens: usage.promptTokens + usage.completionTokens,
      stopReason,
      checks: score(spec, reply, called),
    };
  } catch (err) {
    return {
      spec,
      reply: "",
      called: [],
      ms: Date.now() - startedAt,
      toolCalls: 0,
      tokens: 0,
      error: err.message,
      checks: { toolSelection: false, numericAccuracy: false, noFalseNoData: false },
    };
  }
}

function score(spec, reply, called) {
  const toolSelection =
    (spec.expectTools ?? []).every((t) => called.includes(t)) &&
    !(spec.forbidTools ?? []).some((t) => called.includes(t));

  const numericAccuracy =
    (spec.expectNumbers ?? []).every((n) => containsNumber(reply, n)) &&
    (spec.expectText ?? []).every((t) => reply.toLowerCase().includes(t.toLowerCase())) &&
    (spec.expectPatterns ?? []).every((re) => re.test(reply));

  const noFalseNoData = !(spec.forbidPatterns ?? []).some((re) => re.test(reply));

  return { toolSelection, numericAccuracy, noFalseNoData };
}

/**
 * Value-strict, format-lenient. "$1,234.50", "1234.5" and "1234.50" all match
 * 1234.5; "1234" does not, unless the expected value is a whole number.
 */
function containsNumber(reply, value) {
  const haystack = reply.replace(/,/g, "");
  const magnitude = Math.abs(value);

  const renderings = [magnitude.toFixed(2), magnitude.toFixed(1), String(magnitude)];
  if (Number.isInteger(magnitude)) renderings.push(magnitude.toFixed(0));

  return renderings.some((r) => haystack.includes(r));
}

// ── Reporting ─────────────────────────────────────────────────────────────

function report(results) {
  const pad = (s, n) => String(s).padEnd(n);
  const mark = (ok) => (ok ? "PASS" : "FAIL");

  console.log(pad("QUESTION", 22) + pad("TOOLS", 6) + pad("NUMBERS", 8) + pad("NO-FALSE-NODATA", 17) + pad("CALLS", 6) + "MS");
  console.log("-".repeat(70));

  for (const r of results) {
    console.log(
      pad(r.spec.id, 22) +
        pad(mark(r.checks.toolSelection), 6) +
        pad(mark(r.checks.numericAccuracy), 8) +
        pad(mark(r.checks.noFalseNoData), 17) +
        pad(r.toolCalls, 6) +
        r.ms,
    );

    const failed = !r.checks.toolSelection || !r.checks.numericAccuracy || !r.checks.noFalseNoData;
    if (failed || args.verbose) {
      if (r.error) console.log(`    error: ${r.error}`);
      console.log(`    asked:  ${r.spec.question}`);
      console.log(`    called: ${r.called.join(", ") || "(none)"}`);
      console.log(`    reply:  ${r.reply.replace(/\s+/g, " ").slice(0, 220)}`);
      console.log("");
    }
  }

  const total = results.length;
  const rate = (key) => results.filter((r) => r.checks[key]).length / total;
  const fullyCorrect = results.filter(
    (r) => r.checks.toolSelection && r.checks.numericAccuracy && r.checks.noFalseNoData,
  ).length;

  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const mean = (fn) => (results.reduce((s, r) => s + fn(r), 0) / total).toFixed(1);
  const sorted = [...results].map((r) => r.ms).sort((a, b) => a - b);

  console.log("-".repeat(70));
  console.log(`Fully correct       ${fullyCorrect}/${total}  (${pct(fullyCorrect / total)})`);
  console.log(`Tool selection      ${pct(rate("toolSelection"))}`);
  console.log(`Numeric accuracy    ${pct(rate("numericAccuracy"))}`);
  console.log(`No false "no data"  ${pct(rate("noFalseNoData"))}`);
  console.log(`Mean tool calls     ${mean((r) => r.toolCalls)}`);
  console.log(`Mean tokens         ${mean((r) => r.tokens)}`);
  console.log(`Latency p50 / p95   ${sorted[Math.floor(total * 0.5)]}ms / ${sorted[Math.floor(total * 0.95)]}ms`);
  console.log("");

  const overall = fullyCorrect / total;
  if (overall < THRESHOLD) {
    console.error(`Below threshold: ${pct(overall)} < ${pct(THRESHOLD)}`);
    process.exit(1);
  }
  console.log(`At or above threshold (${pct(THRESHOLD)}).\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index]);
      }
    }),
  );

  return out;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    out[key] = value ?? true;
  }
  return out;
}
