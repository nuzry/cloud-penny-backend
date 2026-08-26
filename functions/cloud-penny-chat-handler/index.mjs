import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { getSystemPrompt } from "./prompts.mjs";
import { toolDefinitions, handleToolUse } from "./tools.mjs";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const bedrockClient = new BedrockRuntimeClient({});

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST"
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  try {
    const tenantId = event.requestContext?.authorizer?.claims?.sub;
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
    
    while (stopReason === "tool_use") {
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
      const outputMessage = response.output.message;
      messages.push(outputMessage); // Append assistant's response (text or tool_use)
      
      stopReason = response.stopReason;
      
      if (stopReason === "tool_use") {
        // Find all tool uses in the assistant's output
        const toolUses = outputMessage.content.filter(c => c.toolUse);
        const toolResults = [];

        for (const block of toolUses) {
          const toolUse = block.toolUse;
          const result = await handleToolUse(docClient, tenantId, toolUse.name, toolUse.input);
          
          toolResults.push({
            toolResult: {
              toolUseId: toolUse.toolUseId,
              content: [{ json: result }],
              status: "success"
            }
          });
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
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Internal server error" })
    };
  }
};
