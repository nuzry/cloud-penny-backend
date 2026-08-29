import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const handleToolUse = vi.fn();
vi.mock('./tools.mjs', () => ({
  toolDefinitions: [{ type: 'function', function: { name: 'getMonthlySpend' } }],
  handleToolUse: (...args) => handleToolUse(...args),
}));

const { handler } = await import('./index.mjs');

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

const authedEvent = (body) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } }, http: { method: 'POST' } },
  body: JSON.stringify(body),
});

const groqResponse = (message, usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({
  ok: true,
  json: async () => ({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage }),
});

describe('chat-handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    handleToolUse.mockReset();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'groq-key' });
    vi.unstubAllGlobals();
  });

  it('handles CORS preflight without touching auth or Dynamo', async () => {
    const res = await handler({ requestContext: { http: { method: 'OPTIONS' } } });
    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: { http: { method: 'POST' } }, body: '{}' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when the message is missing', async () => {
    const res = await handler(authedEvent({}));
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the tenant record does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await handler(authedEvent({ message: 'hi' }));
    expect(res.statusCode).toBe(404);
  });

  it('returns the assistant reply directly when the model needs no tools', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com', connectionStatus: 'VERIFIED' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      groqResponse({ role: 'assistant', content: 'Hello there!' })
    ));

    const res = await handler(authedEvent({ message: 'hi' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.reply).toBe('Hello there!');
    expect(handleToolUse).not.toHaveBeenCalled();
  });

  it('runs one tool-call round trip, feeds the result back, then returns the final reply', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com', connectionStatus: 'VERIFIED' } });
    handleToolUse.mockResolvedValue({ month: '2026-08', totalCost: 100 });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(groqResponse({
        role: 'assistant',
        tool_calls: [{ id: 'call-1', function: { name: 'getMonthlySpend', arguments: '{"month":"2026-08"}' } }],
      }))
      .mockResolvedValueOnce(groqResponse({ role: 'assistant', content: 'You spent $100 in August.' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handler(authedEvent({ message: 'how much did I spend?' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.reply).toBe('You spent $100 in August.');
    expect(handleToolUse).toHaveBeenCalledWith(expect.anything(), 'tenant-123', 'getMonthlySpend', { month: '2026-08' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts after MAX_TOOL_ITERATIONS and returns a graceful fallback reply', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com', connectionStatus: 'VERIFIED' } });
    handleToolUse.mockResolvedValue({ noData: true });

    const alwaysWantsATool = groqResponse({
      role: 'assistant',
      tool_calls: [{ id: 'call-x', function: { name: 'getMonthlySpend', arguments: '{}' } }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(alwaysWantsATool));

    const res = await handler(authedEvent({ message: 'anything' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.reply).toMatch(/wasn't able to find/i);
  });

  it('returns 500 when the Groq API itself errors', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com', connectionStatus: 'VERIFIED' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'groq down' }));

    const res = await handler(authedEvent({ message: 'hi' }));
    expect(res.statusCode).toBe(500);
  });

  // Regression tests for the rate-limit incident: Groq's TPM limit is shared
  // across the whole org, so a burst of requests could trip it. A transient
  // 429 should be retried rather than failing the request outright.
  it('retries once on a transient 429 then succeeds', async () => {
    vi.useFakeTimers();
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com', connectionStatus: 'VERIFIED' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce(groqResponse({ role: 'assistant', content: 'ok now' }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = handler(authedEvent({ message: 'hi' }));
    await vi.advanceTimersByTimeAsync(1000);
    const res = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body).data.reply).toBe('ok now');
    vi.useRealTimers();
  });

  it('returns a friendly rate-limit message when Groq keeps returning 429', async () => {
    vi.useFakeTimers();
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com', connectionStatus: 'VERIFIED' } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = handler(authedEvent({ message: 'hi' }));
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 1000);
    const res = await resultPromise;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.reply).toMatch(/rate limit/i);
    vi.useRealTimers();
  });

  // Regression test: history used to be sent in full on every request with
  // no cap, so a long-running conversation multiplied token usage on every
  // call and made the TPM limit far easier to trip.
  it('trims history to the most recent messages before calling Groq', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com', connectionStatus: 'VERIFIED' } });
    const fetchMock = vi.fn().mockResolvedValue(groqResponse({ role: 'assistant', content: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    const longHistory = Array.from({ length: 30 }, (_, i) => ({ sender: 'user', text: `msg-${i}` }));
    await handler(authedEvent({ message: 'latest', history: longHistory }));

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const historyMessages = sentBody.messages.filter(m => m.role !== 'system' && m.content !== 'latest');
    expect(historyMessages.length).toBeLessThanOrEqual(10);
    expect(historyMessages[historyMessages.length - 1].content).toBe('msg-29');
    expect(historyMessages[0].content).toBe('msg-20');
  });
});
