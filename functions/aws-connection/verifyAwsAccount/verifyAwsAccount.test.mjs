import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const authedEvent = () => ({ requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } } });

describe('verifyAwsAccount', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
  });

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when the tenant has no AWS account configured', async () => {
    ddbMock.on(GetCommand).resolves({ Item: {} });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(400);
  });

  it('returns PENDING when no CUR files have arrived yet', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { awsAccountId: '111111111111' } });
    s3Mock.on(ListObjectsV2Command).resolves({ KeyCount: 0 });

    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.data.connectionStatus).toBe('PENDING');
  });

  it('marks the connection VERIFIED once files are found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { awsAccountId: '111111111111' } });
    s3Mock.on(ListObjectsV2Command).resolves({ KeyCount: 1 });
    ddbMock.on(UpdateCommand).resolves({});

    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.connectionStatus).toBe('VERIFIED');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it('still reports VERIFIED even if the status-update write fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { awsAccountId: '111111111111' } });
    s3Mock.on(ListObjectsV2Command).resolves({ KeyCount: 1 });
    ddbMock.on(UpdateCommand).rejects(new Error('boom'));

    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.connectionStatus).toBe('VERIFIED');
  });
});
