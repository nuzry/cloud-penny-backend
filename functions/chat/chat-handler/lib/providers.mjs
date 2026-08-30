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
    maxRetries = 3,
    baseDelayMs = 1000,
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

      await this.sleep(this.baseDelayMs * 2 ** attempt);
    }

    if (lastStatus === 429) {
      throw new RateLimitError("Provider rate limit exceeded after retries.");
    }
    throw new ProviderError(`Provider request failed (${lastStatus}): ${lastBody.slice(0, 300)}`, {
      status: lastStatus,
    });
  }
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
