import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);
const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';

const authedEvent = (body, conversationId = CONVERSATION_ID) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } },
  pathParameters: { conversationId },
  body: JSON.stringify(body),
});

describe('sendSupportMessage', () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: { message_id: 999 } }) }));
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ botToken: 'bot-token' }) });
  });

  it('returns 400 for a malformed conversation ID', async () => {
    const res = await handler(authedEvent({ message: 'hi' }, 'not-a-uuid'));
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the conversation does not belong to this tenant', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await handler(authedEvent({ message: 'hi' }));
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the conversation is already resolved', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { status: 'RESOLVED' } });
    const res = await handler(authedEvent({ message: 'hi' }));
    expect(res.statusCode).toBe(409);
  });

  it('appends the message as a Telegram reply to the conversation\'s last message', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OPEN', lastTelegramMessageId: 42 } });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const res = await handler(authedEvent({ message: 'follow-up question' }));
    expect(res.statusCode).toBe(200);

    const [, fetchOptions] = global.fetch.mock.calls[0];
    const sentBody = JSON.parse(fetchOptions.body);
    expect(sentBody.reply_to_message_id).toBe(42);
  });
});
