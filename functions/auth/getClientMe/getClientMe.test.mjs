import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);

const authedEvent = (overrides = {}) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } },
  ...overrides,
});

describe('getClientMe', () => {
  beforeEach(() => ddbMock.reset());

  it('returns 401 when no tenant claim is present', async () => {
    const res = await handler({ requestContext: {} });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('returns 404 when the tenant record does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(404);
  });

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('boom'));
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(500);
  });

  it('returns sanitised tenant data on success, omitting unset optional fields', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        tenantId: 'tenant-123',
        email: 'a@b.com',
        planTier: 'free',
        connectionStatus: 'NOT_CONNECTED',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        // no awsAccountId / externalId / roleArn set
      },
    });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.tenantId).toBe('tenant-123');
    expect(body.data).not.toHaveProperty('awsAccountId');
    expect(body.data).not.toHaveProperty('roleArn');
  });

  it('includes optional fields once they exist on the record', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        tenantId: 'tenant-123',
        email: 'a@b.com',
        planTier: 'free',
        connectionStatus: 'VERIFIED',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        awsAccountId: '111111111111',
        dailyRefreshQuota: 3,
      },
    });
    const res = await handler(authedEvent());
    const body = JSON.parse(res.body);
    expect(body.data.awsAccountId).toBe('111111111111');
    expect(body.data.dailyRefreshQuota).toBe(3);
  });
});
