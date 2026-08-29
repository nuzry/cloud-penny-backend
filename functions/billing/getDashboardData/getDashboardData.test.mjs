import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const authedEvent = (qs = {}) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } },
  queryStringParameters: qs,
});

describe('getDashboardData', () => {
  beforeEach(() => ddbMock.reset());

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 500 on a DynamoDB error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('boom'));
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(500);
  });

  it('expands bounded DAY# items back into flat rows', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        date: '2026-08-01',
        totalCost: 12.5,
        updatedAt: '2026-08-02T00:00:00Z',
        items: [{ service: 'AmazonEC2', operation: 'RunInstances', region: 'us-east-1', lineItemType: 'Usage', usageAmount: 1, cost: 12.5 }],
      }],
    });

    const res = await handler(authedEvent({ month: '2026-08' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalCost).toBe(12.5);
    expect(body.data.dailyItems).toHaveLength(1);
    expect(body.data.dailyItems[0].service).toBe('AmazonEC2');
  });

  it('falls back to the MONTH# rollup when no DAY# items exist yet', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({
      Item: { totalCost: 40, currency: 'USD', dailyTotals: { '2026-08-01': 40 }, updatedAt: '2026-08-01T00:00:00Z' },
    });

    const res = await handler(authedEvent({ month: '2026-08' }));
    const body = JSON.parse(res.body);
    expect(body.data.totalCost).toBe(40);
    expect(body.data.dailyItems).toHaveLength(1);
  });

  it('returns an empty-but-successful payload for a brand new tenant with no data at all', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(authedEvent({ month: '2026-08' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.dailyItems).toEqual([]);
    expect(body.data.totalCost).toBe(0);
  });

  it('ignores a malformed month query param and defaults to the current month', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(authedEvent({ month: 'not-a-month' }));
    expect(res.statusCode).toBe(200);
    const call = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    // Should have fallen back to a real YYYY-MM shaped prefix, not the bad input.
    expect(call.ExpressionAttributeValues[':prefix']).toMatch(/^DAY#\d{4}-\d{2}$/);
  });
});
