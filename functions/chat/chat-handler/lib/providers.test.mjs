import { describe, it, expect, vi } from "vitest";
import { GroqProvider, MockProvider } from "./providers.mjs";
import { RateLimitError, ProviderError } from "./errors.mjs";

const okResponse = (message, usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({
  ok: true,
  json: async () => ({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage }),
});

const rateLimitedResponse = (headers = {}) => ({
  ok: false,
  status: 429,
  text: async () => "rate limited",
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

describe("GroqProvider retry timing", () => {
  it("waits exactly the retry-after header value rather than guessing with backoff", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse({ "retry-after": "3" }))
      .mockResolvedValueOnce(okResponse({ role: "assistant", content: "ok" }));

    const provider = new GroqProvider({ apiKey: "k", model: "m", fetchImpl, sleepImpl, maxRetries: 2 });
    const res = await provider.complete({ messages: [], tools: [] });

    expect(res.message.content).toBe("ok");
    expect(sleepImpl).toHaveBeenCalledWith(3000); // 3s from the header, not the 1000ms default backoff
  });

  it("falls back to x-ratelimit-reset-tokens when retry-after is absent", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse({ "x-ratelimit-reset-tokens": "1.2s" }))
      .mockResolvedValueOnce(okResponse({ role: "assistant", content: "ok" }));

    const provider = new GroqProvider({ apiKey: "k", model: "m", fetchImpl, sleepImpl, maxRetries: 2 });
    await provider.complete({ messages: [], tools: [] });

    expect(sleepImpl).toHaveBeenCalledWith(1200);
  });

  it("parses a millisecond-formatted reset value", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse({ "x-ratelimit-reset-tokens": "150ms" }))
      .mockResolvedValueOnce(okResponse({ role: "assistant", content: "ok" }));

    const provider = new GroqProvider({ apiKey: "k", model: "m", fetchImpl, sleepImpl, maxRetries: 2 });
    await provider.complete({ messages: [], tools: [] });

    expect(sleepImpl).toHaveBeenCalledWith(150);
  });

  it("falls back to exponential backoff when no rate-limit header is present", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(okResponse({ role: "assistant", content: "ok" }));

    const provider = new GroqProvider({ apiKey: "k", model: "m", fetchImpl, sleepImpl, maxRetries: 2, baseDelayMs: 1000 });
    await provider.complete({ messages: [], tools: [] });

    expect(sleepImpl).toHaveBeenCalledWith(1000); // baseDelayMs * 2^0
  });

  it("never waits longer than maxDelayMs even if the header asks for more", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse({ "retry-after": "120" }))
      .mockResolvedValueOnce(okResponse({ role: "assistant", content: "ok" }));

    const provider = new GroqProvider({ apiKey: "k", model: "m", fetchImpl, sleepImpl, maxRetries: 2, maxDelayMs: 8000 });
    await provider.complete({ messages: [], tools: [] });

    expect(sleepImpl).toHaveBeenCalledWith(8000);
  });

  it("throws RateLimitError once retries are exhausted", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(rateLimitedResponse({ "retry-after": "1" }));

    const provider = new GroqProvider({ apiKey: "k", model: "m", fetchImpl, sleepImpl, maxRetries: 2 });
    await expect(provider.complete({ messages: [], tools: [] })).rejects.toThrow(RateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("retries a 5xx on the same path as 429", async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable", headers: { get: () => null } })
      .mockResolvedValueOnce(okResponse({ role: "assistant", content: "ok" }));

    const provider = new GroqProvider({ apiKey: "k", model: "m", fetchImpl, sleepImpl, maxRetries: 2 });
    const res = await provider.complete({ messages: [], tools: [] });
    expect(res.message.content).toBe("ok");
  });

  it("does not retry a non-retryable client error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad request", headers: { get: () => null } });
    const provider = new GroqProvider({ apiKey: "k", model: "m", fetchImpl, maxRetries: 3 });

    await expect(provider.complete({ messages: [], tools: [] })).rejects.toThrow(ProviderError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("MockProvider", () => {
  it("plays back a scripted conversation for offline tests", async () => {
    const provider = new MockProvider([{ role: "assistant", content: "hi" }]);
    const res = await provider.complete({ messages: [], tools: [] });
    expect(res.message.content).toBe("hi");
    expect(res.finishReason).toBe("stop");
  });
});
