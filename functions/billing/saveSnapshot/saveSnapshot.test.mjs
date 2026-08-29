import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';
import { handler } from './index.mjs';

const athenaMock = mockClient(AthenaClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const bridgeEvent = (queryExecutionId = 'q-1') => ({ detail: { queryExecutionId } });

const cell = (v) => ({ VarCharValue: v });
const row = (service, operation, region, lineItemType, date, usageAmount, cost) => ({
  Data: [cell(service), cell(operation), cell(region), cell(lineItemType), cell(date), cell(String(usageAmount)), cell(String(cost))],
});

const queryStringWithTags = (tenantId, awsAccountId, billingPeriod) =>
  `--tenantId=${tenantId}\n--awsAccountId=${awsAccountId}\n--billingPeriod=${billingPeriod}\nSELECT 1`;

describe('saveSnapshot', () => {
  beforeEach(() => {
    athenaMock.reset();
    ddbMock.reset();
  });

  it('returns without querying anything when the event has no queryExecutionId', async () => {
    await handler({ detail: {} });
    expect(athenaMock.commandCalls(GetQueryExecutionCommand)).toHaveLength(0);
  });

  it('skips a non-CloudPenny Athena query (no --tenantId= tag)', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: { Query: 'SELECT * FROM some_other_table' },
    });
    await handler(bridgeEvent());
    expect(athenaMock.commandCalls(GetQueryResultsCommand)).toHaveLength(0);
  });

  it('returns without writing when the query produced no data rows', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: { Query: queryStringWithTags('tenant-123', '222222222222', '2026-08') },
    });
    athenaMock.on(GetQueryResultsCommand).resolves({ ResultSet: { Rows: [{ Data: [] }] } });

    await handler(bridgeEvent());
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('aggregates rows into a bounded per-day item and a MONTH# rollup, filtering floating-point dust around zero', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: { Query: queryStringWithTags('tenant-123', '222222222222', '2026-08') },
    });
    athenaMock.on(GetQueryResultsCommand).resolves({
      ResultSet: {
        Rows: [
          { Data: [] }, // header row, skipped
          row('AmazonEC2', 'RunInstances', 'us-east-1', 'Usage', '2026-08-01', 10, 5.5),
          row('AmazonS3', 'PutObject', 'us-east-1', 'Usage', '2026-08-01', 1, 0.25),
          row('AmazonEC2', 'Tax', '', 'Tax', '2026-08-01', 0, 1e-10), // below COST_EPSILON, should be dropped
        ],
      },
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(bridgeEvent());

    const batchCall = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input;
    const dayItem = batchCall.RequestItems['cloudpenny-snapshots-dev'][0].PutRequest.Item;
    expect(dayItem.snapshotId).toBe('DAY#2026-08-01');
    expect(dayItem.totalCost).toBeCloseTo(5.75, 6);
    expect(dayItem.items).toHaveLength(2); // the near-zero row was filtered out

    const monthCall = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(monthCall.Key.snapshotId).toBe('MONTH#2026-08');
    expect(monthCall.ExpressionAttributeValues[':tc']).toBeCloseTo(5.75, 6);
    // The MONTH# write must be guarded so an older, less-complete query
    // can't win a race against a newer one and clobber the rollup.
    expect(monthCall.ConditionExpression).toMatch(/lastQuerySubmittedAt/);
  });

  // Regression test for the bug this guard fixes: getSpendByService reported
  // a near-zero service as "top" because a slow, older-query saveSnapshot
  // invocation finished after a newer one and overwrote MONTH# with stale
  // data, even though the per-day items (written per-date, so they can't
  // collide) stayed correct the whole time.
  it('does not overwrite the MONTH# rollup when a newer query has already written one (out-of-order finish)', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: {
        Query: queryStringWithTags('tenant-123', '222222222222', '2026-08'),
        Status: { SubmissionDateTime: new Date('2026-08-29T10:00:00Z') }, // older query, submitted first
      },
    });
    athenaMock.on(GetQueryResultsCommand).resolves({
      ResultSet: { Rows: [{ Data: [] }, row('AmazonEC2', 'RunInstances', 'us-east-1', 'Usage', '2026-08-01', 1, 1)] },
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const conditionalError = Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
    ddbMock.on(UpdateCommand).rejects(conditionalError);

    // Should not throw — a lost race is an expected, silent no-op, not a failure.
    await expect(handler(bridgeEvent())).resolves.not.toThrow();
  });

  it('retries BatchWrite when items come back unprocessed, then succeeds', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: { Query: queryStringWithTags('tenant-123', '222222222222', '2026-08') },
    });
    athenaMock.on(GetQueryResultsCommand).resolves({
      ResultSet: { Rows: [{ Data: [] }, row('AmazonEC2', 'RunInstances', 'us-east-1', 'Usage', '2026-08-01', 10, 5.5)] },
    });
    ddbMock.on(UpdateCommand).resolves({});

    let call = 0;
    ddbMock.on(BatchWriteCommand).callsFake((input) => {
      call++;
      if (call === 1) {
        return { UnprocessedItems: { 'cloudpenny-snapshots-dev': input.RequestItems['cloudpenny-snapshots-dev'] } };
      }
      return { UnprocessedItems: {} };
    });

    await handler(bridgeEvent());
    expect(call).toBe(2);
  });

  it('collapses per-day items beyond the top-40 cap into "Other (aggregated)" rows, keeping per-service totals exact', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: { Query: queryStringWithTags('tenant-123', '222222222222', '2026-08') },
    });

    const rows = [{ Data: [] }];
    // 45 distinct operations for the same service/day — exceeds TOP_ITEMS_PER_DAY (40)
    for (let i = 0; i < 45; i++) {
      rows.push(row('AmazonEC2', `Op${i}`, 'us-east-1', 'Usage', '2026-08-01', 1, 1));
    }
    athenaMock.on(GetQueryResultsCommand).resolves({ ResultSet: { Rows: rows } });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(bridgeEvent());

    const dayItem = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input
      .RequestItems['cloudpenny-snapshots-dev'][0].PutRequest.Item;

    expect(dayItem.totalCost).toBe(45); // exact regardless of truncation
    expect(dayItem.items.length).toBeLessThanOrEqual(41); // 40 kept + 1 "Other" rollup
    expect(dayItem.items.some(i => i.operation === 'Other (aggregated)')).toBe(true);
  });
});
