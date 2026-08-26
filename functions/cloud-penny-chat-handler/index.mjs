import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { getSystemPrompt } from "./prompts.mjs";
import { toolDefinitions, handleToolUse } from "./tools.mjs";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const bedrockClient = new BedrockRuntimeClient({});

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"; // Using Global Cross-Region for Claude Haiku 4.5

// Hard ceiling on tool-use round trips per user message. Prevents a single
// request from spiraling into dozens of Bedrock calls (and burning the
// daily token quota) if the model can't get a satisfying tool result.
const MAX_TOOL_ITERATIONS = 5;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST"
};

const extractTenantId = (event) =>
  event?.requestContext?.authorizer?.jwt?.claims?.sub ??
  event?.requestContext?.authorizer?.claims?.sub ??
  null;

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

    // 2. Format History for Converse API
    // Converse API expects: { role: "user"|"assistant", content: [{ text: "..." }] }
    const messages = history.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: [{ text: msg.text }]
    }));

    // Add current user message
    messages.push({
      role: 'user',
      content: [{ text: message }]
    });

    // 3. Bedrock Converse Loop
    let finalResponse = "";
    let stopReason = "tool_use";
    let iterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (stopReason === "tool_use") {
      iterations++;

      if (iterations > MAX_TOOL_ITERATIONS) {
        console.warn(
          `[TOOL LOOP ABORTED] tenant=${tenantId} exceeded ${MAX_TOOL_ITERATIONS} tool-use iterations. ` +
          `totalInputTokens=${totalInputTokens} totalOutputTokens=${totalOutputTokens}`
        );
        finalResponse =
          "I wasn't able to find an answer to that using the available data. " +
          "This can happen if the relevant cost data isn't available yet for the period you asked about.";
        break;
      }

      const command = new ConverseCommand({
        modelId: MODEL_ID,
        messages: messages,
        system: [{ text: systemPrompt }],
        toolConfig: {
          tools: toolDefinitions
        },
        inferenceConfig: { temperature: 0.1, maxTokens: 2000 }
      });

      const response = await bedrockClient.send(command);

      if (response.usage) {
        totalInputTokens += response.usage.inputTokens || 0;
        totalOutputTokens += response.usage.outputTokens || 0;
      }

      console.log(
        `[CONVERSE] tenant=${tenantId} iteration=${iterations} stopReason=${response.stopReason} ` +
        `usage=${JSON.stringify(response.usage)}`
      );

      const outputMessage = response.output.message;
      messages.push(outputMessage); // Append assistant's response (text or tool_use)

      stopReason = response.stopReason;

      if (stopReason === "tool_use") {
        // Find all tool uses in the assistant's output
        const toolUses = outputMessage.content.filter(c => c.toolUse);
        const toolResults = [];

        for (const block of toolUses) {
          const toolUse = block.toolUse;

          try {
            const result = await handleToolUse(docClient, tenantId, toolUse.name, toolUse.input);

            // handleToolUse never throws (it catches internally), but a tool
            // can still report a logical error (e.g. "no data found"). We
            // pass that through as a normal successful toolResult so the
            // model sees it and can decide what to do next - the system
            // prompt tells it not to keep retrying in that case.
            toolResults.push({
              toolResult: {
                toolUseId: toolUse.toolUseId,
                content: [{ json: result }],
                status: "success"
              }
            });
          } catch (toolErr) {
            // Defensive: only reached if something outside handleToolUse's
            // own try/catch throws (e.g. a DynamoDB client-level failure).
            console.error(`[TOOL ERROR] tenant=${tenantId} tool=${toolUse.name}:`, toolErr);
            toolResults.push({
              toolResult: {
                toolUseId: toolUse.toolUseId,
                content: [{ json: { error: toolErr.message || "Tool execution failed." } }],
                status: "error"
              }
            });
          }
        }

        // Append the tool results as a 'user' message so the model can read them
        messages.push({
          role: "user",
          content: toolResults
        });
      } else {
        // Model is done, extract the text
        const textContent = outputMessage.content.find(c => c.text);
        if (textContent) {
          finalResponse = textContent.text;
        }
      }
    }

    console.log(
      `[CHAT COMPLETE] tenant=${tenantId} iterations=${iterations} ` +
      `totalInputTokens=${totalInputTokens} totalOutputTokens=${totalOutputTokens}`
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
