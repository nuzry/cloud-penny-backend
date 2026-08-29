import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const ALERTS_TABLE = process.env.ALERTS_TABLE ?? "cloudpenny-alerts-dev";

// Simplified HTTP response helper
const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": true,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(body)
});

export const handler = async (event) => {
  console.log("RECEIVED_EVENT:", JSON.stringify(event, null, 2));
  
  try {
    // 1. Authenticate Request
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims) {
      return response(401, { success: false, error: "Unauthorized" });
    }

    const tenantId = claims.sub;
    
    // 2. Fetch Alerts from DynamoDB
    const res = await dynamo.send(new QueryCommand({
      TableName: ALERTS_TABLE,
      KeyConditionExpression: "tenantId = :tid",
      ExpressionAttributeValues: {
        ":tid": tenantId
      },
      ScanIndexForward: false // Sort by createdAt descending
    }));

    // 3. Return Alerts
    return response(200, {
      success: true,
      data: res.Items || []
    });

  } catch (err) {
    console.error("Error fetching alerts:", err);
    return response(500, { success: false, error: "Internal Server Error" });
  }
};
