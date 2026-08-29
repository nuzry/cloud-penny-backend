import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const authedEvent = () => ({ requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } } });

describe('getConversations', () => {
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

  it('sorts conversations by most recent message first', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { conversationId: 'c1', lastMessageAt: '2026-08-01T00:00:00Z' },
        { conversationId: 'c2', lastMessageAt: '2026-08-05T00:00:00Z' },
      ],
    });
    const res = await handler(authedEvent());
    const body = JSON.parse(res.body);
    expect(body.data[0].conversationId).toBe('c2');
  });
});
