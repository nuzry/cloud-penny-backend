import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { getSystemPrompt } from "./prompts.mjs";
import { toolDefinitions, handleToolUse } from "./tools.mjs";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new SecretsManagerClient({});

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const GROQ_SECRET_NAME = process.env.GROQ_SECRET_NAME || "cloudpenny-groq-api-key-dev";
const MODEL_ID = process.env.GROQ_MODEL_ID || "openai/gpt-oss-120b";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// Hard ceiling on tool-use round trips per user message. Prevents a single
// request from spiraling into dozens of Groq calls (and burning cost/latency)
// if the model can't get a satisfying tool result.
const MAX_TOOL_ITERATIONS = 5;

// How many prior messages to carry as context. The full thread used to be
// resent on every call with no cap, and since the tool loop can itself fire
// up to MAX_TOOL_ITERATIONS times per question, a growing conversation could
// multiply token usage across a single request enough to trip Groq's
// per-organization tokens-per-minute limit (shared across all API keys in
// the org, so rotating the key doesn't reset it).
const MAX_HISTORY_MESSAGES = 10;

// Groq's TPM limit is low enough that a burst of requests (or one long
// tool-calling loop) can trip it transiently. Groq's own error message names
// a short wait ("try again in 960ms"); backing off and retrying a couple of
// times turns a hard failure into a slightly slower answer instead.
const GROQ_MAX_RETRIES = 3;
const GROQ_RETRY_BASE_MS = 1000;

async function callGroqWithRetry(payload, apiKey) {
  for (let attempt = 0; attempt <= GROQ_MAX_RETRIES; attempt++) {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (res.status !== 429 || attempt === GROQ_MAX_RETRIES) {
      return res;
    }

    const waitMs = GROQ_RETRY_BASE_MS * 2 ** attempt;
    console.warn(`[GROQ RATE LIMIT] attempt=${attempt + 1}/${GROQ_MAX_RETRIES + 1} waiting ${waitMs}ms before retry`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST"
};

const extractTenantId = (event) =>
  event?.requestContext?.authorizer?.jwt?.claims?.sub ??
  event?.requestContext?.authorizer?.claims?.sub ??
  null;

// Cached in module scope so a warm Lambda container only calls Secrets
// Manager once, not on every invocation.
let cachedApiKey = null;
async function getGroqApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: GROQ_SECRET_NAME }));
  cachedApiKey = res.SecretString;
  return cachedApiKey;
}

export const handler = async (event) => {
  console.log("INCOMING EVENT:", JSON.stringify(event));
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  try {
    const tenantId = extractTenantId(event);
    if (!tenantId) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const body = JSON.parse(event.body);
    const { message, history = [] } = body;

    if (!message) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Message is required" }) };
    }

    // 1. Fetch Tenant Context (Name, Connection Status)
    const { Item: tenant } = await docClient.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId }
    }));

    if (!tenant) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Tenant not found" }) };
    }

    const systemPrompt = getSystemPrompt(tenant);
    const apiKey = await getGroqApiKey();

    // 2. Format History for Groq's OpenAI-compatible chat-completions API:
    // { role: "system"|"user"|"assistant"|"tool", content: "..." } — a flat
    // string per message, unlike Bedrock Converse's { content: [{text}] }.
    const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);
    const messages = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory.map(msg => ({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text
      })),
      { role: "user", content: message }
    ];

    // 3. Groq tool-use loop
    let finalResponse = "";
    let iterations = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let done = false;

    while (!done) {
      iterations++;

      if (iterations > MAX_TOOL_ITERATIONS) {
        console.warn(
          `[TOOL LOOP ABORTED] tenant=${tenantId} exceeded ${MAX_TOOL_ITERATIONS} tool-use iterations. ` +
          `totalPromptTokens=${totalPromptTokens} totalCompletionTokens=${totalCompletionTokens}`
        );
        finalResponse =
          "I wasn't able to find an answer to that using the available data. " +
          "This can happen if the relevant cost data isn't available yet for the period you asked about.";
        break;
      }

      const groqRes = await callGroqWithRetry({
        model: MODEL_ID,
        messages,
        tools: toolDefinitions,
        tool_choice: "auto",
        temperature: 0.1,
        max_tokens: 2000
      }, apiKey);

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        console.error(`[GROQ ERROR] tenant=${tenantId} status=${groqRes.status}:`, errText);
        if (groqRes.status === 429) {
          finalResponse = "Penny AI is getting a lot of questions right now and hit a temporary rate limit. Please try again in a few seconds.";
          done = true;
          break;
        }
        throw new Error(`Groq API error (${groqRes.status})`);
      }

      const data = await groqRes.json();

      if (data.usage) {
        totalPromptTokens += data.usage.prompt_tokens || 0;
        totalCompletionTokens += data.usage.completion_tokens || 0;
      }

      const choice = data.choices?.[0];
      const assistantMessage = choice?.message;

      console.log(
        `[GROQ] tenant=${tenantId} iteration=${iterations} finishReason=${choice?.finish_reason} ` +
        `usage=${JSON.stringify(data.usage)}`
      );

      if (!assistantMessage) {
        throw new Error("Groq returned no message in response.");
      }

      messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls || [];

      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          let toolInput = {};
          try {
            toolInput = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
          } catch (parseErr) {
            console.error(`[TOOL ARGS PARSE ERROR] tenant=${tenantId} tool=${toolCall.function.name}:`, parseErr);
          }

          let toolResultContent;
          try {
            // handleToolUse never throws (it catches internally), but a tool
            // can still report a logical error (e.g. "no data found"). We
            // pass that through as a normal tool result so the model sees it
            // and can decide what to do next - the system prompt tells it
            // not to keep retrying in that case.
            const result = await handleToolUse(docClient, tenantId, toolCall.function.name, toolInput);
            toolResultContent = JSON.stringify(result);
          } catch (toolErr) {
            // Defensive: only reached if something outside handleToolUse's
            // own try/catch throws (e.g. a DynamoDB client-level failure).
            console.error(`[TOOL ERROR] tenant=${tenantId} tool=${toolCall.function.name}:`, toolErr);
            toolResultContent = JSON.stringify({ error: toolErr.message || "Tool execution failed." });
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResultContent
          });
        }
        // Loop again so the model can read the tool results.
      } else {
        finalResponse = assistantMessage.content || "";
        done = true;
      }
    }

    console.log(
      `[CHAT COMPLETE] tenant=${tenantId} iterations=${iterations} ` +
      `totalPromptTokens=${totalPromptTokens} totalCompletionTokens=${totalCompletionTokens}`
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        data: {
          reply: finalResponse
        }
      })
    };

  } catch (error) {
    console.error("Error processing chat:", error);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Internal server error" }) };
  }
};
