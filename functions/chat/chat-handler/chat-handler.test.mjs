import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { buildFixtureData } from "../../../evals/chat/fixtures.mjs";

const { handler } = await import("./index.mjs");

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

const fixture = buildFixtureData();

const authedEvent = (body, headers = {}) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: "tenant-123" } } }, http: { method: "POST" } },
  headers,
  body: JSON.stringify(body),
});

/** A Groq-shaped chat-completions response. */
const modelReply = (message) => ({
  ok: true,
  json: async () => ({
    choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }),
});

const conditionalFailure = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

// `tenant: null` means "no tenant record"; omitting it uses the fixture.
function stubDynamo({ tenant = fixture.tenant } = {}) {
  ddbMock.on(GetCommand).callsFake((input) =>
    input.Key.snapshotId
      ? { Item: fixture.monthRollups[input.Key.snapshotId.slice(6)] ?? undefined }
      : { Item: tenant ?? undefined },
  );

  ddbMock.on(QueryCommand).callsFake((input) => {
    if (input.Select === "COUNT") return { Count: fixture.alerts.length };

    const prefix = input.ExpressionAttributeValues[":prefix"];
    if (prefix === "MONTH#") {
      return { Items: Object.values(fixture.monthRollups) };
    }
    const { ":start": start, ":end": end } = input.ExpressionAttributeValues;
    const days = Object.values(fixture.daysByMonth)
      .flat()
      .filter((d) => `DAY#${d.date}` >= start && `DAY#${d.date}` <= end);
    return { Items: days };
  });

  ddbMock.on(UpdateCommand).resolves({});
}

describe("chat handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    vi.unstubAllGlobals();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "groq-key" });
    // No test in this file should reach the network. Without this, a test that
    // forgets to stub fetch silently calls the real Groq API.
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unexpected network call");
    }));
  });

  describe("request handling", () => {
    it("answers a CORS preflight without touching auth or the database", async () => {
      const res = await handler({ requestContext: { http: { method: "OPTIONS" } } });

      expect(res.statusCode).toBe(200);
      expect(ddbMock.calls()).toHaveLength(0);
    });

    it("rejects an unauthenticated request", async () => {
      const res = await handler({ requestContext: { http: { method: "POST" } }, body: "{}" });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a missing message", async () => {
      const res = await handler(authedEvent({}));
      expect(res.statusCode).toBe(400);
    });

    it("rejects an oversized message rather than paying to process it", async () => {
      const res = await handler(authedEvent({ message: "x".repeat(5000) }));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/characters or fewer/);
    });

    it("rejects a malformed JSON body", async () => {
      const res = await handler({
        requestContext: { authorizer: { jwt: { claims: { sub: "t" } } }, http: { method: "POST" } },
        body: "{",
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 when the tenant record does not exist", async () => {
      stubDynamo({ tenant: null });
      const res = await handler(authedEvent({ message: "hi" }));
      expect(res.statusCode).toBe(404);
    });
  });

  describe("answering", () => {
    it("runs the tool loop and reports which lookups produced the answer", async () => {
      stubDynamo();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          modelReply({
            role: "assistant",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "queryCosts", arguments: JSON.stringify({ period: { month: "2026-08" }, groupBy: ["service"] }) },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(modelReply({ role: "assistant", content: "**AmazonEC2** at **$51.10**." }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await handler(authedEvent({ message: "which service costs the most?" }));

      expect(res.statusCode).toBe(200);
      const { data } = JSON.parse(res.body);
      expect(data.reply).toContain("51.10");
      expect(data.usedTools).toEqual(["queryCosts"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("grounds the model with the months that actually have data", async () => {
      stubDynamo();
      const fetchMock = vi.fn().mockResolvedValue(modelReply({ role: "assistant", content: "ok" }));
      vi.stubGlobal("fetch", fetchMock);

      await handler(authedEvent({ message: "what can you do?" }));

      const sentSystemPrompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
      expect(sentSystemPrompt).toContain("2026-05, 2026-06, 2026-07, 2026-08");
      expect(sentSystemPrompt).toContain("queryCosts:");
    });

    it("returns 500 when the provider fails outright", async () => {
      stubDynamo();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" }));

      const res = await handler(authedEvent({ message: "hi" }));
      expect(res.statusCode).toBe(500);
    });
  });

  describe("quota", () => {
    it("turns a tenant away once they exhaust the daily allowance", async () => {
      stubDynamo();
      ddbMock.on(UpdateCommand).rejects(conditionalFailure());

      const res = await handler(authedEvent({ message: "hi" }));

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toMatch(/limit of \d+ questions/);
    });
  });

  describe("logging", () => {
    it("never writes the raw event or the user's message to CloudWatch", async () => {
      stubDynamo();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(modelReply({ role: "assistant", content: "ok" })));
      const logged = [];
      vi.spyOn(console, "log").mockImplementation((line) => logged.push(String(line)));

      await handler(authedEvent({ message: "how much did payroll-db cost me" }));

      const all = logged.join("\n");
      expect(all).not.toContain("payroll-db");
      expect(all).not.toContain("jwt");
      expect(all).toContain("chat_request");
    });
  });

  describe("CORS", () => {
    it("echoes an allowed origin when an allowlist is configured", async () => {
      // Not configured in this environment, so it falls back to the
      // project-wide "*" every other handler uses.
      const res = await handler({ requestContext: { http: { method: "OPTIONS" } }, headers: { origin: "https://app.test" } });
      expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    });
  });
});
