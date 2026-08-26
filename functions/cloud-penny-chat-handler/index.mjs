import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const bedrockClient = new BedrockRuntimeClient({});

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE || "cloudpenny-snapshots-dev"; // fallback if env missing

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST"
};

export const handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ""
    };
  }

  try {
    const tenantId = event.requestContext?.authorizer?.claims?.sub;
    if (!tenantId) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Unauthorized" })
      };
    }

    const body = JSON.parse(event.body);
    const { message, history = [] } = body;

    if (!message) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Message is required" })
      };
    }

    // 1. Fetch Tenant Context
    const { Item: tenant } = await docClient.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId }
    }));

    if (!tenant) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Tenant not found" })
      };
    }

    // 2. Fetch Latest Snapshot (assuming Partition Key is tenantId)
    const { Items: snapshots } = await docClient.send(new QueryCommand({
      TableName: SNAPSHOTS_TABLE,
      KeyConditionExpression: "tenantId = :tId",
      ExpressionAttributeValues: {
        ":tId": tenantId
      },
      ScanIndexForward: false, // get latest first
      Limit: 1
    }));
    const latestSnapshot = snapshots && snapshots.length > 0 ? snapshots[0] : null;

    // 3. Construct Bedrock Prompt
    const systemPrompt = `You are Penny AI, a highly specialized Cloud Cost Optimization assistant.
Your ONLY purpose is to answer questions related to the user's AWS billing, cost optimization, and account details based on the provided snapshots.
If the user asks a question that is NOT directly related to their cloud costs or cloud infrastructure, you MUST politely decline to answer.
Example: "I am Penny AI. I can only help you with AWS billing and platform queries."

<tenant_context>
Company Name: ${tenant.companyName || "Unknown"}
AWS Connection Status: ${tenant.awsConnected ? "Connected" : "Not Connected"}
</tenant_context>

<billing_snapshot>
${latestSnapshot ? JSON.stringify(latestSnapshot, null, 2) : "No billing data available yet."}
</billing_snapshot>

Always be concise, professional, and helpful. Format your responses in plain text or simple markdown.`;

    // 4. Prepare Claude 3.5 Sonnet payload
    // Bedrock Model ID for Claude 3.5 Sonnet
    const modelId = "anthropic.claude-3-5-sonnet-20240620-v1:0";
    
    const formattedHistory = history.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: [{ type: "text", text: msg.text }]
    }));
    
    // Add current message
    formattedHistory.push({
      role: 'user',
      content: [{ type: "text", text: message }]
    });

    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1000,
      system: systemPrompt,
      messages: formattedHistory,
      temperature: 0.1,
    };

    // 5. Invoke Bedrock
    const command = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const botResponse = responseBody.content[0].text;

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        data: {
          reply: botResponse
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
