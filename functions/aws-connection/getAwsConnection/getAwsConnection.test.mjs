import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const authedEvent = () => ({ requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } } });

describe('getAwsConnection', () => {
  beforeEach(() => ddbMock.reset());

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the tenant does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(404);
  });

  it('returns UNCONNECTED default when no connectionStatus is set', async () => {
    ddbMock.on(GetCommand).resolves({ Item: {} });
    const res = await handler(authedEvent());
    const body = JSON.parse(res.body);
    expect(body.data.connectionStatus).toBe('UNCONNECTED');
    expect(body.data.awsAccountId).toBeNull();
  });

  it('includes a CloudFormation quick-launch URL when PENDING with an account ID', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { connectionStatus: 'PENDING', awsAccountId: '111111111111' } });
    const res = await handler(authedEvent());
    const body = JSON.parse(res.body);
    expect(body.data.cfUrl).toContain('cloudformation/home');
    expect(body.data.cfUrl).toContain('param_TenantId=tenant-123');
  });

  it('omits cfUrl once VERIFIED', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { connectionStatus: 'VERIFIED', awsAccountId: '111111111111' } });
    const res = await handler(authedEvent());
    const body = JSON.parse(res.body);
    expect(body.data).not.toHaveProperty('cfUrl');
  });
});
