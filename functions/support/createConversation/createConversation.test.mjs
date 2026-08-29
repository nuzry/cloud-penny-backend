import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

const authedEvent = (body) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } },
  body: JSON.stringify(body),
});

describe('createConversation', () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    vi.unstubAllGlobals();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ botToken: 'bot-token' }) });
  });

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: {}, body: '{}' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when the subject is missing', async () => {
    const res = await handler(authedEvent({ message: 'help me' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the message is missing', async () => {
    const res = await handler(authedEvent({ subject: 'Billing question' }));
    expect(res.statusCode).toBe(400);
  });

  it('creates the conversation even if the Telegram relay fails entirely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('telegram down')));
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com' } });
    ddbMock.on(PutCommand).resolves({});

    const res = await handler(authedEvent({ subject: 'Billing question', message: 'Why was I charged twice?' }));
    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2); // meta + first message
  });

  it('relays to Telegram and stores the returned message ID for correlation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 555 } }),
    }));
    ddbMock.on(GetCommand).resolves({ Item: { email: 'a@b.com' } });
    ddbMock.on(PutCommand).resolves({});

    const res = await handler(authedEvent({ subject: 'Billing question', message: 'Why was I charged twice?' }));
    expect(res.statusCode).toBe(200);

    const messageItem = ddbMock.commandCalls(PutCommand)
      .map(c => c.args[0].input.Item)
      .find(i => i.sortKey?.startsWith('CONVMSG#'));
    expect(messageItem.telegramMessageId).toBe(555);
  });
});
