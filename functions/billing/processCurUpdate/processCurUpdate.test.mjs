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

  it('skips when the tenant has already exhausted this billing period\'s quota for today, and marks it pending', async () => {
    const today = new Date().toISOString().split('T')[0];
    ddbMock.on(GetCommand).resolves({
      Item: { awsAccountId: '222222222222', dailyRefreshQuota: 1, [`refreshDate_2026-08`]: today, [`refreshUsed_2026-08`]: 1 },
    });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(sqsEvent(validKey));

    expect(athenaMock.commandCalls(StartQueryExecutionCommand)).toHaveLength(0);
    const pendingCall = ddbMock.commandCalls(UpdateCommand).find(
      (c) => c.args[0].input.ExpressionAttributeNames?.['#p'] === 'pendingReprocess_2026-08'
    );
    expect(pendingCall).toBeTruthy();
  });

  it('does not let a fully-used current-month quota starve a correction to a different (older) billing period', async () => {
    const today = new Date().toISOString().split('T')[0];
    const oldKey = `${TENANT_ID}/CloudPenny-Export/data/BILLING_PERIOD=2026-07/part-0.snappy.parquet`;
    ddbMock.on(GetCommand).resolves({
      Item: {
        awsAccountId: '222222222222',
        dailyRefreshQuota: 1,
        [`refreshDate_2026-08`]: today,
        [`refreshUsed_2026-08`]: 1, // current month's quota already spent today
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    athenaMock.on(StartQueryExecutionCommand).resolves({ QueryExecutionId: 'q-1' });

    // A correction for 2026-07 (a different billing period) arrives the same day.
    await handler(sqsEvent(oldKey, '2026-08-15T00:00:00Z'));

    const call = athenaMock.commandCalls(StartQueryExecutionCommand)[0]?.args[0].input;
    expect(call).toBeTruthy();
    expect(call.QueryString).toContain('--billingPeriod=2026-07');
  });

  it('catches up a previously pending billing period once quota is available again, using this invocation', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        awsAccountId: '222222222222',
        dailyRefreshQuota: 5,
        'pendingReprocess_2026-07': true, // a correction landed for July while quota was exhausted
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    athenaMock.on(StartQueryExecutionCommand).resolves({ QueryExecutionId: 'q-1' });

    await handler(sqsEvent(validKey)); // triggers today's normal August event

    const periods = athenaMock.commandCalls(StartQueryExecutionCommand).map(
      (c) => c.args[0].input.QueryString.match(/--billingPeriod=(\S+)/)[1]
    );
    expect(periods).toEqual(expect.arrayContaining(['2026-08', '2026-07']));

    const clearedPending = ddbMock.commandCalls(UpdateCommand).some(
      (c) => c.args[0].input.UpdateExpression === 'REMOVE #p' &&
        c.args[0].input.ExpressionAttributeNames?.['#p'] === 'pendingReprocess_2026-07'
    );
    expect(clearedPending).toBe(true);
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
    // Surfaces the CUR's own currency instead of leaving saveSnapshot to
    // hardcode "USD" regardless of what the payer account actually bills in.
    expect(call.QueryString).toContain('line_item_currency_code');
  });
});
