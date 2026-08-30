import { RateLimitError } from "./errors.mjs";

/**
 * Provider-agnostic tool-calling loop.
 *
 * Everything that used to be tangled into the Lambda handler — budgets,
 * retries, tool dispatch, token accounting, logging — lives here, behind one
 * function with injected dependencies. The handler is left doing only HTTP
 * concerns, and the whole loop is testable without AWS or a network.
 *
 * Every stop condition produces a usable answer rather than an exception:
 * running out of iterations, tokens or tool calls ends the turn with a
 * truthful message about what was found so far.
 */

export const DEFAULT_LIMITS = {
  maxIterations: 6,
  maxToolCalls: 8,
  maxTokens: 24000,
  maxHistoryMessages: 10,
  maxMessageChars: 4000,
};

export async function runAgent({
  provider,
  systemPrompt,
  history = [],
  message,
  tools,
  tenantId,
  limits = {},
  log = defaultLog,
}) {
  const budget = { ...DEFAULT_LIMITS, ...limits };

  const messages = [
    { role: "system", content: systemPrompt },
    ...sanitiseHistory(history, budget),
    { role: "user", content: truncate(message, budget.maxMessageChars) },
  ];

  const trace = [];
  const usage = { promptTokens: 0, completionTokens: 0 };
  let iterations = 0;
  let toolCalls = 0;

  while (true) {
    if (iterations >= budget.maxIterations) {
      return finish(exhausted("iterations", trace), "iteration_budget");
    }
    if (usage.promptTokens + usage.completionTokens >= budget.maxTokens) {
      return finish(exhausted("tokens", trace), "token_budget");
    }

    iterations++;

    let turn;
    try {
      turn = await provider.complete({ messages, tools: tools.definitions });
    } catch (err) {
      if (err instanceof RateLimitError) {
        return finish(
          "Penny is handling a lot of questions right now and hit a temporary rate limit. Please try again in a few seconds.",
          "rate_limited",
        );
      }
      throw err;
    }

    usage.promptTokens += turn.usage.promptTokens;
    usage.completionTokens += turn.usage.completionTokens;

    messages.push(turn.message);

    const requested = turn.message.tool_calls ?? [];
    if (!requested.length) {
      return finish(turn.message.content ?? "", "complete");
    }

    // The model is allowed to ask for several lookups at once; running them
    // concurrently keeps a multi-part question at roughly single-lookup
    // latency instead of adding a round trip per tool.
    const allowed = requested.slice(0, Math.max(budget.maxToolCalls - toolCalls, 0));
    toolCalls += allowed.length;

    const results = await Promise.all(
      allowed.map(async (call) => {
        const args = parseArgs(call.function.arguments);
        const startedAt = Date.now();
        const result = await tools.dispatch(tenantId, call.function.name, args);

        trace.push({
          tool: call.function.name,
          args,
          ms: Date.now() - startedAt,
          noData: Boolean(result?.noData),
          invalidArguments: Boolean(result?.invalidArguments),
          error: result?.error ?? null,
        });

        return { call, result };
      }),
    );

    for (const { call, result } of results) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    // Any calls beyond the budget still need a tool message, or the provider
    // rejects the next request for having an unanswered tool_call.
    for (const call of requested.slice(allowed.length)) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          error: "Tool call budget for this question is exhausted. Answer with what you already have.",
        }),
      });
    }
  }

  function finish(reply, stopReason) {
    log({
      event: "chat_complete",
      tenantId,
      provider: provider.name,
      stopReason,
      iterations,
      toolCalls,
      tools: trace.map((t) => t.tool),
      noDataResults: trace.filter((t) => t.noData).length,
      invalidArgumentResults: trace.filter((t) => t.invalidArguments).length,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });

    return { reply, trace, usage, stopReason, iterations, toolCalls };
  }
}

function exhausted(kind, trace) {
  const looked = [...new Set(trace.map((t) => t.tool))].join(", ");
  return looked
    ? `I ran out of ${kind === "tokens" ? "room" : "steps"} while working that out. I checked ${looked} but could not finish the answer — try asking about one specific month or service at a time.`
    : "I could not work that one out. Try asking about one specific month or service at a time.";
}

/**
 * History arrives from the browser, so it is input, not state: roles are
 * normalised, length is capped, and each message is truncated. Server-side
 * conversation storage would remove the need for this entirely.
 */
function sanitiseHistory(history, budget) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-budget.maxHistoryMessages)
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      role: m.sender === "user" ? "user" : "assistant",
      content: truncate(m.text, budget.maxMessageChars),
    }));
}

function truncate(text, max) {
  const str = String(text ?? "");
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function parseArgs(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Returned as-is so dispatch's validation produces a corrective message
    // rather than the turn dying on a malformed argument string.
    return {};
  }
}

function defaultLog(payload) {
  console.log(JSON.stringify(payload));
}
