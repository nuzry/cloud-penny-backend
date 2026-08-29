import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const authedEvent = () => ({ requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } } });

describe('getAlerts', () => {
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

  it('returns the tenant\'s alerts newest-first', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ anomalyId: 'a1' }, { anomalyId: 'a2' }] });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
    const call = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(call.ScanIndexForward).toBe(false);
  });
});
