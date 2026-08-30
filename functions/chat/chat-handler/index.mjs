import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

import { createDynamoRepository } from "./lib/repository.mjs";
import { buildManifest } from "./lib/manifest.mjs";
import { createTools } from "./lib/tools.mjs";
import { createProvider } from "./lib/providers.mjs";
import { runAgent } from "./lib/agent.mjs";
import { consumeChatQuota, DEFAULT_DAILY_CHAT_QUOTA } from "./lib/quota.mjs";
import { buildSystemPrompt } from "./prompt.mjs";

/**
 * Penny AI chat endpoint.
 *
 * This handler does HTTP concerns only — auth, validation, quota, wiring and
 * the response envelope. Everything else lives behind an injected dependency:
 *
 *   repository  -> DynamoDB reads              (lib/repository.mjs)
 *   queryCosts  -> filter/group/aggregate      (lib/queryCosts.mjs)
 *   tools       -> what the model may call     (lib/tools.mjs)
 *   provider    -> which model answers         (lib/providers.mjs)
 *   agent       -> the tool-calling loop       (lib/agent.mjs)
 *
 * That layering is what makes the assistant testable: the eval harness in
 * evals/chat swaps the repository for fixtures and the provider for a script,
 * and exercises the identical code path with no AWS and no API key.
 */

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "cloudpenny-snapshots-dev";
const ALERTS_TABLE = process.env.ALERTS_TABLE || "cloudpenny-alerts-dev";
const GROQ_SECRET_NAME = process.env.GROQ_SECRET_NAME || "cloudpenny-groq-api-key-dev";
const MODEL_ID = process.env.GROQ_MODEL_ID || "openai/gpt-oss-120b";
const AI_PROVIDER = process.env.AI_PROVIDER || "groq";

// Comma-separated origin allowlist. Left unset it falls back to "*", which is
// what every other handler in this project does and is safe here because the
// API authenticates with a bearer JWT rather than cookies — a cross-origin
// page cannot attach the user's token. Set it to lock the endpoint down.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const MAX_MESSAGE_CHARS = 2000;

const extractTenantId = (event) =>
  event?.requestContext?.authorizer?.jwt?.claims?.sub ??
  event?.requestContext?.authorizer?.claims?.sub ??
  null;

// Module scope, so a warm container calls Secrets Manager once rather than
// on every invocation.
let cachedApiKey = null;
async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: GROQ_SECRET_NAME }));
  cachedApiKey = res.SecretString;
  return cachedApiKey;
}

function corsHeaders(event) {
  const origin = event?.headers?.origin ?? event?.headers?.Origin;
  const allowed =
    ALLOWED_ORIGINS.length === 0 ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    ...(ALLOWED_ORIGINS.length ? { Vary: "Origin" } : {}),
  };
}

const respond = (event, statusCode, body) => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(body),
});

const log = (payload) => console.log(JSON.stringify(payload));

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod;
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  const startedAt = Date.now();
  let tenantId = null;

  try {
    tenantId = extractTenantId(event);
    if (!tenantId) {
      return respond(event, 401, { error: "Unauthorized" });
    }

    let body;
    try {
      body = JSON.parse(event.body ?? "{}");
    } catch {
      return respond(event, 400, { error: "Request body must be valid JSON." });
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return respond(event, 400, { error: "Message is required" });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return respond(event, 400, { error: `Message must be ${MAX_MESSAGE_CHARS} characters or fewer.` });
    }

    // Deliberately never logs the event or the message text — both carry the
    // user's own billing questions and their JWT claims, and CloudWatch is
    // not the place for either.
    log({ event: "chat_request", tenantId, messageChars: message.length, historyLength: body.history?.length ?? 0 });

    const repo = createDynamoRepository({
      docClient,
      tables: { tenants: TENANTS_TABLE, snapshots: SNAPSHOTS_TABLE, alerts: ALERTS_TABLE },
    });

    const today = new Date().toISOString().slice(0, 10);
    const manifest = await buildManifest(repo, tenantId);

    if (!manifest) {
      return respond(event, 404, { error: "Tenant not found" });
    }

    const quota = manifest.tenant.dailyChatQuota ?? DEFAULT_DAILY_CHAT_QUOTA;
    const { allowed } = await consumeChatQuota({
      docClient,
      table: TENANTS_TABLE,
      tenantId,
      quota,
      today,
    });

    if (!allowed) {
      log({ event: "chat_quota_exceeded", tenantId, quota });
      return respond(event, 429, {
        error: `You've reached your limit of ${quota} questions for today. Penny will be available again tomorrow.`,
      });
    }

    const tools = createTools({ repo, today, manifest });

    const provider = createProvider({
      provider: AI_PROVIDER,
      apiKey: AI_PROVIDER === "groq" ? await getApiKey() : undefined,
      model: MODEL_ID,
    });

    const { reply, trace, stopReason } = await runAgent({
      provider,
      systemPrompt: buildSystemPrompt({
        manifest,
        capabilityLines: tools.capabilityLines,
        today,
      }),
      history: body.history,
      message,
      tools,
      tenantId,
      log,
    });

    log({ event: "chat_latency", tenantId, ms: Date.now() - startedAt, stopReason });

    return respond(event, 200, {
      data: {
        reply,
        // Which lookups produced this answer. The UI can surface these as
        // "checked: cost by service, August 2026" so a figure is traceable
        // to its source rather than taken on trust.
        usedTools: [...new Set(trace.map((t) => t.tool))],
      },
    });
  } catch (error) {
    log({ event: "chat_error", tenantId, name: error?.name, message: error?.message });
    return respond(event, 500, { error: "Internal server error" });
  }
};
