// lambdas/postConfirmationFunction/index.js
import { CognitoIdentityProviderClient, AdminAddUserToGroupCommand, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const cognito = new CognitoIdentityProviderClient({});
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const TABLE   = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";

const now = () => new Date().toISOString();

export const handler = async (event) => {
  console.log("EVENT_PRINT:", JSON.stringify(event, null, 2));

  const tenantId = event.request.userAttributes.sub;
  const email    = event.request.userAttributes.email;

  console.log("TENANT_ID:", tenantId, "EMAIL:", email);

  // Step 1 — Add to Cognito group
  try {
    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: event.userPoolId,
      Username:   event.userName,
      GroupName:  "cloud-penny-client"
    }));
    console.log("COGNITO_GROUP_SUCCESS");
  } catch (err) {
    console.error("COGNITO_GROUP_ERROR:", err.name, err.message);
    await rollbackDeleteUser(event);
    throw new Error("Failed to assign user to group — account removed, please sign up again");
  }

  // Step 2 — Write initial tenant record.
  // externalId is intentionally absent — generated lazily by getExternalId.
  // roleArn / lastVerifiedAt / lastFailureReason are intentionally absent —
  // they only exist once the client goes through the AWS connection flow.
  try {
    const item = {
      tenantId,
      email,
      planTier:         "free",
      connectionStatus: "NOT_CONNECTED",
      createdAt:        now(),
      updatedAt:        now()
    };

    console.log("DYNAMO_ITEM_TO_WRITE:", JSON.stringify(item));

    await dynamo.send(new PutCommand({
      TableName:           TABLE,
      Item:                item,
      ConditionExpression: "attribute_not_exists(tenantId)"
    }));

    console.log("DYNAMO_WRITE_SUCCESS");
  } catch (err) {
    console.error("DYNAMODB_WRITE_ERROR:", err.name, err.message);
    await rollbackDeleteUser(event);
    throw new Error("Failed to create tenant record — account removed, please sign up again");
  }

  return event;
};

const rollbackDeleteUser = async (event) => {
  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: event.userPoolId,
      Username:   event.userName
    }));
    console.log("ROLLBACK_SUCCESS: Cognito user deleted — email is free to retry");
  } catch (err) {
    console.error("ROLLBACK_FAILED — MANUAL INTERVENTION REQUIRED:", {
      username:   event.userName,
      email:      event.request.userAttributes.email,
      userPoolId: event.userPoolId,
      error:      err.message
    });
  }
};