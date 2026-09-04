import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const ses = new SESClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const TABLE = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";
const AWS_ACCOUNT_ID_INDEX = "awsAccountId-index";
const SENDER_EMAIL = process.env.SENDER_EMAIL ?? "thenuzry@gmail.com";

// Query the awsAccountId-index GSI. This used to be a full-table Scan that
// only ever checked its first page (~1MB) — once the tenants table grew past
// that, a tenant living in a later page came back as "no match" and the
// anomaly (already detected by AWS) was silently dropped forever. The GSI
// makes this an O(matches) lookup instead of O(all tenants), and — since it
// still returns every item sharing that awsAccountId rather than enforcing
// uniqueness — still surfaces the rare case of two tenants sharing one AWS
// account for resolveSingleTenant() to refuse to guess between.
async function findTenantsByAwsAccountId(awsAccountId) {
  const items = [];
  let cursor;

  do {
    const res = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: AWS_ACCOUNT_ID_INDEX,
      KeyConditionExpression: "awsAccountId = :aid",
      ExpressionAttributeValues: { ":aid": awsAccountId },
      ExclusiveStartKey: cursor,
    }));
    items.push(...(res.Items || []));
    cursor = res.LastEvaluatedKey;
  } while (cursor);

  return items;
}

// Nothing today enforces that awsAccountId is unique across tenants (see
// saveAwsAccount), so this stays defensive even after that gap is closed:
// if it ever finds more than one tenant for the same AWS account, guessing
// which one is "right" (as the old code did via Items[0]) can leak one
// tenant's cost-anomaly details to a different tenant's inbox. Refusing to
// send is the safe failure mode; support can resolve the collision manually.
function resolveSingleTenant(tenants, awsAccountId) {
  if (tenants.length === 0) return null;
  if (tenants.length === 1) return tenants[0];

  console.error(
    `[AMBIGUOUS] ${tenants.length} tenants are registered against AWS Account ID ${awsAccountId} ` +
    `(${tenants.map((t) => t.tenantId).join(", ")}). Refusing to guess which one this anomaly belongs to.`
  );
  return null;
}

// SNS is at-least-once delivery, so the same anomaly notification can arrive
// more than once. The alerts table's key is (tenantId, createdAt), and
// createdAt used to be generated fresh on every invocation — meaning a
// redelivered notification created a second, distinct alert for the same
// underlying anomaly (duplicate entries in the feed, inflated alertCount,
// a second email). Checking for an existing item with this anomalyId first
// makes the write idempotent without needing a schema change.
async function alreadyRecorded(alertsTable, tenantId, anomalyId) {
  const res = await dynamo.send(new QueryCommand({
    TableName: alertsTable,
    KeyConditionExpression: "tenantId = :t",
    FilterExpression: "anomalyId = :aid",
    ExpressionAttributeValues: { ":t": tenantId, ":aid": anomalyId },
  }));
  return (res.Items || []).length > 0;
}

export const handler = async (event) => {
  console.log("RECEIVED_EVENT:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.Sns.Message);
      console.log("ANOMALY_MESSAGE:", JSON.stringify(message, null, 2));

      // Extract AWS Account ID from the monitorArn or linkedAccount
      let awsAccountId = null;
      if (message.monitorArn) {
        awsAccountId = message.monitorArn.split(":")[4];
      }

      if (!awsAccountId && message.anomalies && message.anomalies.length > 0) {
         const anomaly = message.anomalies[0];
         if (anomaly.rootCauses && anomaly.rootCauses.length > 0) {
            awsAccountId = anomaly.rootCauses[0].linkedAccount;
         }
      }

      if (!awsAccountId) {
        console.warn("Could not determine AWS Account ID from message. Skipping.");
        continue;
      }

      console.log(`Looking up tenant for AWS Account ID: ${awsAccountId}`);

      // Lookup the tenant in DynamoDB (fully paginated — see comment above)
      const matches = await findTenantsByAwsAccountId(awsAccountId);
      const tenant = resolveSingleTenant(matches, awsAccountId);

      if (!tenant) {
        console.warn(`No unambiguous tenant found for AWS Account ID: ${awsAccountId}. Skipping alert.`);
        continue;
      }

      const recipientEmail = tenant.email;

      if (!recipientEmail) {
        console.warn(`Tenant ${tenant.tenantId} has no email address. Skipping alert.`);
        continue;
      }

      const ALERTS_TABLE = process.env.ALERTS_TABLE ?? "cloudpenny-alerts-dev";
      const anomalyId = message.anomalies && message.anomalies.length > 0 ? message.anomalies[0].anomalyId : `alert-${Date.now()}`;

      if (await alreadyRecorded(ALERTS_TABLE, tenant.tenantId, anomalyId)) {
        console.log(`[DEDUPE] Anomaly ${anomalyId} for tenant ${tenant.tenantId} was already recorded — skipping duplicate SNS delivery.`);
        continue;
      }

      // Save the alert to DynamoDB first — this is what makes it show up in
      // the UI, and it must not depend on (or be lost to) an email failure.
      // A prior incident: SES rejected an unverified recipient, that error
      // escaped un-caught, and the DynamoDB write below never ran — so the
      // anomaly was detected but never appeared on the dashboard.
      const alertItem = {
        tenantId: tenant.tenantId,
        createdAt: new Date().toISOString(),
        anomalyId: anomalyId,
        awsAccountId: awsAccountId,
        message: message,
        status: "UNREAD"
      };

      await dynamo.send(new PutCommand({
        TableName: ALERTS_TABLE,
        Item: alertItem
      }));
      console.log("Alert saved to DynamoDB successfully.");

      console.log(`Sending alert to ${recipientEmail} for tenant ${tenant.tenantId}`);

      const htmlBody = `
        <h2>Cloud Penny - Cost Anomaly Alert</h2>
        <p>AWS Cost Anomaly Detection has identified unusual spending behavior in your connected AWS Account (<strong>${awsAccountId}</strong>).</p>
        <p><strong>Details:</strong></p>
        <pre>${JSON.stringify(message, null, 2)}</pre>
        <br/>
        <p>Please log in to your AWS Console or Cloud Penny dashboard to investigate this spike.</p>
        <p>Best,<br/>The Cloud Penny Team</p>
      `;

      try {
        await ses.send(new SendEmailCommand({
          Source: SENDER_EMAIL,
          Destination: {
            ToAddresses: [recipientEmail]
          },
          Message: {
            Subject: { Data: `AWS Cost Anomaly Detected - Account ${awsAccountId}` },
            Body: {
              Html: { Data: htmlBody }
            }
          }
        }));
        console.log("Alert email sent successfully.");
      } catch (emailErr) {
        console.warn(`Failed to send email to ${recipientEmail}:`, emailErr.message);
      }

    } catch (err) {
      console.error("Error processing record:", err);
    }
  }
};
