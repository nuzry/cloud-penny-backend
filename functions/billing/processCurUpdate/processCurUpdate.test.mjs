import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AthenaClient, StartQueryExecutionCommand } from '@aws-sdk/client-athena';
import { GlueClient, GetTablesCommand, GetCrawlerCommand, StartCrawlerCommand } from '@aws-sdk/client-glue';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const athenaMock = mockClient(AthenaClient);
const glueMock = mockClient(GlueClient);

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const sqsEvent = (objectKey, eventTime = '2026-08-15T00:00:00Z') => ({
  Records: [{
    body: JSON.stringify({
      Records: [{
        eventTime,
        s3: { bucket: { name: 'central-bucket' }, object: { key: objectKey } },
      }],
    }),
  }],
});

const validKey = `${TENANT_ID}/CloudPenny-Export/data/BILLING_PERIOD=2026-08/part-0.snappy.parquet`;

describe('processCurUpdate', () => {
  beforeEach(() => {
    ddbMock.reset();
    athenaMock.reset();
    glueMock.reset();
    // Crawler READY and already fresh relative to the event, by default.
    glueMock.on(GetCrawlerCommand).resolves({
      Crawler: { State: 'READY', LastCrawl: { StartTime: new Date('2026-09-01T00:00:00Z') } },
    });
    glueMock.on(GetTablesCommand).resolves({ TableList: [] });
  });

  it('skips a plain s3:TestEvent without error', async () => {
    await expect(handler({ Records: [{ body: JSON.stringify({ Event: 's3:TestEvent' }) }] }))
      .resolves.toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('skips a non-parquet object key', async () => {
    await handler(sqsEvent(`${TENANT_ID}/Export/data/BILLING_PERIOD=2026-08/manifest.json`));
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('skips a key with an invalid tenantId shape (defense against SQL injection via key path)', async () => {
    await handler(sqsEvent(`not-a-uuid/Export/data/BILLING_PERIOD=2026-08/part.snappy.parquet`));
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('skips when the tenant has no record in DynamoDB', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    await handler(sqsEvent(validKey));
    expect(athenaMock.commandCalls(StartQueryExecutionCommand)).toHaveLength(0);
  });

  it('skips when the tenant has already exhausted today\'s quota', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { awsAccountId: '222222222222', dailyRefreshQuota: 1, lastRefreshDate: new Date().toISOString().split('T')[0], dailyRefreshesUsed: 1 },
    });
    await handler(sqsEvent(validKey));
    expect(athenaMock.commandCalls(StartQueryExecutionCommand)).toHaveLength(0);
  });

  it('throws to trigger an SQS retry when the Glue crawler is still running', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { awsAccountId: '222222222222' } });
    glueMock.on(GetCrawlerCommand).resolves({ Crawler: { State: 'RUNNING' } });

    await expect(handler(sqsEvent(validKey))).rejects.toThrow(/RUNNING/);
    expect(athenaMock.commandCalls(StartQueryExecutionCommand)).toHaveLength(0);
  });

  it('starts the crawler and retries when it is stale relative to the S3 event', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { awsAccountId: '222222222222' } });
    glueMock.on(GetCrawlerCommand).resolves({
      Crawler: { State: 'READY', LastCrawl: { StartTime: new Date('2020-01-01T00:00:00Z') } },
    });
    glueMock.on(StartCrawlerCommand).resolves({});

    await expect(handler(sqsEvent(validKey))).rejects.toThrow(/Started it/);
    expect(glueMock.commandCalls(StartCrawlerCommand)).toHaveLength(1);
  });

  it('starts an Athena query scoped to the exact billing period on success, tagging tenant/account/period in SQL comments', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { awsAccountId: '222222222222' } });
    ddbMock.on(UpdateCommand).resolves({});
    athenaMock.on(StartQueryExecutionCommand).resolves({ QueryExecutionId: 'q-1' });

    await handler(sqsEvent(validKey));

    const call = athenaMock.commandCalls(StartQueryExecutionCommand)[0].args[0].input;
    expect(call.QueryString).toContain(`--tenantId=${TENANT_ID}`);
    expect(call.QueryString).toContain('--awsAccountId=222222222222');
    expect(call.QueryString).toContain('--billingPeriod=2026-08');
    expect(call.QueryString).toContain("billing_period = '2026-08'");
  });
});
