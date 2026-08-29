import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESClient);

const snsEvent = (message) => ({
  Records: [{ Sns: { Message: JSON.stringify(message) } }],
});

const anomalyMessage = {
  monitorArn: 'arn:aws:ce::222222222222:anomalymonitor/abc',
  anomalies: [{ anomalyId: 'anomaly-1', impact: { totalImpact: 42 } }],
};

describe('processAnomalyAlert', () => {
  beforeEach(() => {
    ddbMock.reset();
    sesMock.reset();
  });

  it('skips the record when no AWS account ID can be derived from the message', async () => {
    await handler(snsEvent({ anomalies: [] }));
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('skips the record when no tenant matches the account ID', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    await handler(snsEvent(anomalyMessage));
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('skips the record when the matched tenant has no email on file', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ tenantId: 't1' }] });
    await handler(snsEvent(anomalyMessage));
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('saves the alert to DynamoDB even when the SES email send fails (the regression this covers)', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ tenantId: 't1', email: 'a@b.com' }] });
    ddbMock.on(PutCommand).resolves({});
    sesMock.on(SendEmailCommand).rejects(new Error('Email address is not verified.'));

    await handler(snsEvent(anomalyMessage));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.tenantId).toBe('t1');
    expect(item.anomalyId).toBe('anomaly-1');
    expect(item.status).toBe('UNREAD');
  });

  it('saves the alert and sends the email on a fully healthy path', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ tenantId: 't1', email: 'a@b.com' }] });
    ddbMock.on(PutCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({});

    await handler(snsEvent(anomalyMessage));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it('does not let one bad record stop the others in the same batch from being processed', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ tenantId: 't1', email: 'a@b.com' }] });
    ddbMock.on(PutCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({});

    const badRecord = { Sns: { Message: 'not valid json' } };
    const goodRecord = { Sns: { Message: JSON.stringify(anomalyMessage) } };

    await handler({ Records: [badRecord, goodRecord] });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });
});
