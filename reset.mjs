import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-southeast-1" }));

async function run() {
  await dynamo.send(new UpdateCommand({
    TableName: "cloudpenny-tenants",
    Key: { tenantId: "096af58c-80d1-708b-426a-78e1b888b745" },
    UpdateExpression: "SET dailyRefreshesUsed = :val",
    ExpressionAttributeValues: { ":val": 0 }
  }));
  console.log("Reset successfully.");
}
run();
