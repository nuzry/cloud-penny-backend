import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Per-tenant daily chat quota.
 *
 * A single question can cost several provider round trips, and the Groq TPM
 * limit is shared across the whole organisation — so one tenant asking in a
 * loop degrades the assistant for everybody. This is the same atomic
 * check-and-increment idiom processCurUpdate uses for refresh quota: two
 * independent conditional updates, so concurrent requests can never both win
 * the same day's reset or push the count past the limit.
 */

export const DEFAULT_DAILY_CHAT_QUOTA = 50;

export async function consumeChatQuota({ docClient, table, tenantId, quota, today }) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: table,
      Key: { tenantId },
      UpdateExpression: "SET chatMessagesUsed = chatMessagesUsed + :one",
      ConditionExpression: "lastChatDate = :today AND chatMessagesUsed < :quota",
      ExpressionAttributeValues: { ":one": 1, ":today": today, ":quota": quota },
    }));
    return { allowed: true };
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
  }

  // Either the tenant has never chatted, or this is their first message today.
  try {
    await docClient.send(new UpdateCommand({
      TableName: table,
      Key: { tenantId },
      UpdateExpression: "SET chatMessagesUsed = :one, lastChatDate = :today",
      ConditionExpression: "attribute_not_exists(lastChatDate) OR lastChatDate <> :today",
      ExpressionAttributeValues: { ":one": 1, ":today": today },
    }));
    return { allowed: true };
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
  }

  return { allowed: false, quota };
}
