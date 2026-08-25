import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" }));
const ses = new SESClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });

const TABLE = process.env.TENANTS_TABLE ?? "cloudpenny-tenants";
const SENDER_EMAIL = process.env.SENDER_EMAIL ?? "thenuzry@gmail.com";

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

      // Lookup the tenant in DynamoDB
      const dbRes = await dynamo.send(new ScanCommand({
        TableName: TABLE,
        FilterExpression: "awsAccountId = :aid",
        ExpressionAttributeValues: {
          ":aid": awsAccountId
        }
      }));

      if (!dbRes.Items || dbRes.Items.length === 0) {
        console.warn(`No active tenant found for AWS Account ID: ${awsAccountId}. Skipping alert.`);
        continue;
      }

      const tenant = dbRes.Items[0];
      const recipientEmail = tenant.email;

      if (!recipientEmail) {
        console.warn(`Tenant ${tenant.tenantId} has no email address. Skipping alert.`);
        continue;
      }

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

      // Save alert to DynamoDB
      const ALERTS_TABLE = process.env.ALERTS_TABLE ?? "cloudpenny-alerts-dev";
      const anomalyId = message.anomalies && message.anomalies.length > 0 ? message.anomalies[0].anomalyId : `alert-${Date.now()}`;
      
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

    } catch (err) {
      console.error("Error processing record:", err);
    }
  }
};
