import { ProviderError, RateLimitError } from "./errors.mjs";

/**
 * Model provider abstraction.
 *
 * The agent runtime talks to this interface, never to Groq directly, so
 * swapping model or vendor is a config change rather than a rewrite of the
 * tool loop. This is the same contract the standalone local-ai-gateway
 * defined; folding it in here removes the second, unused implementation.
 *
 * The contract:
 *
 *   complete({ messages, tools }) -> {
 *     message:      { role, content, tool_calls? },
 *     usage:        { promptTokens, completionTokens },
 *     finishReason: string
 *   }
 *
 * Implementations throw RateLimitError when the upstream is throttling after
 * retries, and ProviderError for anything else. They never return a partial
 * or empty message.
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GroqProvider {
  constructor({
    apiKey,
    model,
    fetchImpl = fetch,
    maxRetries = 4,
    baseDelayMs = 1000,
    maxDelayMs = 8000,
    sleepImpl = sleep,
    temperature = 0.1,
    maxTokens = 2000,
  }) {
    this.name = `groq:${model}`;
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.sleep = sleepImpl;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  async complete({ messages, tools }) {
    const res = await this.#post({
      model: this.model,
      messages,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    });

    const data = await res.json();
    const choice = data.choices?.[0];

    if (!choice?.message) {
      throw new ProviderError("Provider returned a response with no message.");
    }

    return {
      message: choice.message,
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * Groq's tokens-per-minute limit is per organisation, so a burst from
   * anywhere in the account can throttle a single user's question. Backing
   * off turns that into a slower answer rather than a failed one. 5xx is
   * retried on the same path since it is equally transient.
   *
   * Groq's 429 response carries a `retry-after` header (seconds) and, more
   * precisely, `x-ratelimit-reset-tokens` — the actual time until the TPM
   * window has room again. A fixed exponential backoff has no way to know
   * that number, so it either waits too little (retries fail again) or too
   * much (a fast-clearing window gets treated like a slow one). Reading the
   * header and waiting exactly that long turns most "exhausted retries"
   * failures into a slower but successful answer instead.
   */
  async #post(payload) {
    let lastStatus;
    let lastBody = "";

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchImpl(GROQ_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) return res;

      lastStatus = res.status;
      lastBody = await res.text().catch(() => "");

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === this.maxRetries) break;

      await this.sleep(this.#resolveWaitMs(res, attempt));
    }

    if (lastStatus === 429) {
      throw new RateLimitError("Provider rate limit exceeded after retries.");
    }
    throw new ProviderError(`Provider request failed (${lastStatus}): ${lastBody.slice(0, 300)}`, {
      status: lastStatus,
    });
  }

  #resolveWaitMs(res, attempt) {
    const fallback = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    const headers = res.headers;
    if (!headers?.get) return fallback;

    // `headers.get` returns null when absent, and Number(null) is 0, not
    // NaN — checked explicitly so a missing header falls through to the
    // next source instead of resolving to "wait zero milliseconds".
    const retryAfterRaw = headers.get("retry-after");
    if (retryAfterRaw != null && retryAfterRaw !== "") {
      const retryAfter = Number(retryAfterRaw);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        return Math.min(retryAfter * 1000, this.maxDelayMs);
      }
    }

    const resetTokens = parseGroqDurationMs(headers.get("x-ratelimit-reset-tokens"));
    if (resetTokens !== null) {
      return Math.min(resetTokens, this.maxDelayMs);
    }

    return fallback;
  }
}

/** Groq reports rate-limit reset windows as e.g. "1.2s" or "150ms". */
function parseGroqDurationMs(value) {
  if (!value) return null;
  const match = /^([\d.]+)(ms|s)$/.exec(String(value).trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] === "s" ? amount * 1000 : amount;
}

/**
 * Scripted provider for tests and the offline half of the eval harness.
 *
 * Accepts either a fixed list of assistant messages, played in order, or a
 * function of the conversation so far — enough to exercise multi-step tool
 * loops, budget exhaustion and error handling end to end with no API key,
 * no network and no cost.
 */
export class MockProvider {
  constructor(script = []) {
    this.name = "mock";
    this.script = script;
    this.calls = [];
  }

  async complete({ messages, tools }) {
    this.calls.push({ messages: [...messages], tools });

    const next =
      typeof this.script === "function"
        ? this.script(messages, this.calls.length - 1)
        : this.script[this.calls.length - 1];

    if (!next) {
      throw new ProviderError("MockProvider script exhausted — the loop asked for more turns than were scripted.");
    }

    const message = typeof next === "string" ? { role: "assistant", content: next } : next;

    return {
      message,
      finishReason: message.tool_calls?.length ? "tool_calls" : "stop",
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
}

export function createProvider({ provider = "groq", apiKey, model, ...rest }) {
  switch (provider) {
    case "mock":
      return new MockProvider(rest.script ?? []);
    case "groq":
      return new GroqProvider({ apiKey, model, ...rest });
    default:
      throw new ProviderError(`Unknown provider "${provider}".`);
  }
}
