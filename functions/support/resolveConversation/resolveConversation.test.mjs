import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);
const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';

const authedEvent = (conversationId = CONVERSATION_ID) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } },
  pathParameters: { conversationId },
});

describe('resolveConversation', () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ botToken: 'bot-token' }) });
  });

  it('returns 404 when the conversation does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(404);
  });

  it('is idempotent for an already-resolved conversation', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { status: 'RESOLVED' } });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('marks OPEN as RESOLVED and notifies Telegram when a message ID is on file', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OPEN', lastTelegramMessageId: 42 } });
    ddbMock.on(UpdateCommand).resolves({});

    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe('RESOLVED');
    expect(global.fetch).toHaveBeenCalled();
  });

  it('still resolves successfully even if the Telegram notification fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OPEN', lastTelegramMessageId: 42 } });
    ddbMock.on(UpdateCommand).resolves({});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('telegram down')));

    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
  });
});
