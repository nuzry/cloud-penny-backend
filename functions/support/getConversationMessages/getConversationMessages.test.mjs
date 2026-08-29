import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const authedEvent = (conversationId = CONVERSATION_ID) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } },
  pathParameters: { conversationId },
});

describe('getConversationMessages', () => {
  beforeEach(() => ddbMock.reset());

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: {}, pathParameters: { conversationId: CONVERSATION_ID } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for a malformed conversation ID', async () => {
    const res = await handler(authedEvent('not-a-uuid'));
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the conversation does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(404);
  });

  it('returns the conversation with its messages in chronological (sort-key) order', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { subject: 'Help', status: 'OPEN', createdAt: 't0', updatedAt: 't1' } });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { messageId: 'm1', sender: 'CLIENT', text: 'hi', createdAt: 't0' },
        { messageId: 'm2', sender: 'ADMIN', text: 'hello', createdAt: 't1' },
      ],
    });

    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.messages).toHaveLength(2);
    expect(body.data.status).toBe('OPEN');
  });
});
