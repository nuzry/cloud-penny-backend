import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

const webhookEvent = (update, secret = 'correct-secret') => ({
  headers: { 'x-telegram-bot-api-secret-token': secret },
  body: JSON.stringify(update),
});

const replyUpdate = (text, repliedToId = 42) => ({
  message: {
    message_id: 100,
    chat: { id: -1 },
    text,
    reply_to_message: { message_id: repliedToId },
  },
});

describe('telegramWebhook', () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ botToken: 'bot-token', webhookSecret: 'correct-secret' }),
    });
  });

  it('rejects a request with a missing or wrong secret token — the only access control on this public route', async () => {
    const res = await handler(webhookEvent(replyUpdate('hi'), 'wrong-secret'));
    expect(res.statusCode).toBe(401);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('ignores ordinary group chatter that is not a reply to one of our messages', async () => {
    const res = await handler(webhookEvent({ message: { message_id: 1, chat: { id: -1 }, text: 'hello' } }));
    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('no-ops when the reply cannot be correlated to any known conversation', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const res = await handler(webhookEvent(replyUpdate('hi')));
    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('tells the admin the conversation is already resolved and does not relay the message', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ tenantId: 't1', conversationId: 'c1' }] });
    ddbMock.on(GetCommand).resolves({ Item: { status: 'RESOLVED' } });

    const res = await handler(webhookEvent(replyUpdate('too late')));
    expect(res.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('resolves the conversation via a "/resolve" reply without relaying it as a message', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ tenantId: 't1', conversationId: 'c1' }] });
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OPEN' } });
    ddbMock.on(UpdateCommand).resolves({});

    const res = await handler(webhookEvent(replyUpdate('/resolve')));
    expect(res.statusCode).toBe(200);
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(updateCall.ExpressionAttributeValues[':resolved']).toBe('RESOLVED');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('relays a normal admin reply as a new ADMIN message and updates the conversation preview', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ tenantId: 't1', conversationId: 'c1' }] });
    ddbMock.on(GetCommand).resolves({ Item: { status: 'OPEN' } });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const res = await handler(webhookEvent(replyUpdate('Here is the answer to your question.')));
    expect(res.statusCode).toBe(200);

    const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(putItem.sender).toBe('ADMIN');
    expect(putItem.text).toBe('Here is the answer to your question.');
  });

  it('always returns 200 even on an internal error, so Telegram does not hammer retries', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('dynamo down'));
    const res = await handler(webhookEvent(replyUpdate('hi')));
    expect(res.statusCode).toBe(200);
  });
});
