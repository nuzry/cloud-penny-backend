import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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

// Two independent Query lookups share the same DynamoDBDocumentClient:
// the tenants table's awsAccountId-index (find who owns this AWS account)
// and the alerts table (has this anomalyId already been recorded). Dispatch
// on IndexName rather than juggling aws-sdk-client-mock matcher precedence.
let tenantPages;
let tenantCallCount;
let alreadyRecordedResult;

function setTenantMatches(items) {
  tenantPages = [{ Items: items }];
}

describe('processAnomalyAlert', () => {
  beforeEach(() => {
    ddbMock.reset();
    sesMock.reset();
    tenantPages = [{ Items: [] }];
    tenantCallCount = 0;
    alreadyRecordedResult = { Items: [] }; // default: anomaly was never recorded before

    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === 'awsAccountId-index') {
        const page = tenantPages[tenantCallCount] ?? { Items: [] };
        tenantCallCount++;
        return page;
      }
      return alreadyRecordedResult;
    });
  });

  it('skips the record when no AWS account ID can be derived from the message', async () => {
    await handler(snsEvent({ anomalies: [] }));
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('skips the record when no tenant matches the account ID', async () => {
    setTenantMatches([]);
    await handler(snsEvent(anomalyMessage));
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('skips the record when the matched tenant has no email on file', async () => {
    setTenantMatches([{ tenantId: 't1' }]);
    await handler(snsEvent(anomalyMessage));
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('saves the alert to DynamoDB even when the SES email send fails (the regression this covers)', async () => {
    setTenantMatches([{ tenantId: 't1', email: 'a@b.com' }]);
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
    setTenantMatches([{ tenantId: 't1', email: 'a@b.com' }]);
    ddbMock.on(PutCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({});

    await handler(snsEvent(anomalyMessage));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);

    // Looked the tenant up via the GSI, not a table scan.
    const tenantLookup = ddbMock.commandCalls(QueryCommand).find((c) => c.args[0].input.IndexName === 'awsAccountId-index');
    expect(tenantLookup.args[0].input.TableName).toBe('cloudpenny-tenants');
    expect(tenantLookup.args[0].input.KeyConditionExpression).toBe('awsAccountId = :aid');
  });

  it('pages through a Query that spans multiple pages instead of only checking the first one', async () => {
    tenantPages = [
      { Items: [], LastEvaluatedKey: { tenantId: 'cursor-1' } },
      { Items: [{ tenantId: 't1', email: 'a@b.com' }] },
    ];
    ddbMock.on(PutCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({});

    await handler(snsEvent(anomalyMessage));

    const tenantLookups = ddbMock.commandCalls(QueryCommand).filter((c) => c.args[0].input.IndexName === 'awsAccountId-index');
    expect(tenantLookups).toHaveLength(2);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item.tenantId).toBe('t1');
  });

  it('refuses to guess and does not send when two tenants are registered against the same AWS account ID', async () => {
    setTenantMatches([{ tenantId: 't1', email: 'a@b.com' }, { tenantId: 't2', email: 'c@d.com' }]);

    await handler(snsEvent(anomalyMessage));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('does not create a duplicate alert (or resend the email) when the same anomaly is redelivered by SNS', async () => {
    setTenantMatches([{ tenantId: 't1', email: 'a@b.com' }]);
    alreadyRecordedResult = { Items: [{ tenantId: 't1', anomalyId: 'anomaly-1' }] }; // already recorded
    ddbMock.on(PutCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({});

    await handler(snsEvent(anomalyMessage));

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('does not let one bad record stop the others in the same batch from being processed', async () => {
    setTenantMatches([{ tenantId: 't1', email: 'a@b.com' }]);
    ddbMock.on(PutCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({});

    const badRecord = { Sns: { Message: 'not valid json' } };
    const goodRecord = { Sns: { Message: JSON.stringify(anomalyMessage) } };

    await handler({ Records: [badRecord, goodRecord] });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });
});
