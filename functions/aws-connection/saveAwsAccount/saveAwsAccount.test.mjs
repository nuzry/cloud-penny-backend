import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetBucketPolicyCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const authedEvent = (body) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } },
  body: JSON.stringify(body),
});

describe('saveAwsAccount', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
  });

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: {}, body: '{}' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an AWS account ID that is not exactly 12 digits', async () => {
    const res = await handler(authedEvent({ awsAccountId: '123' }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing awsAccountId', async () => {
    const res = await handler(authedEvent({}));
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 when the DynamoDB update fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('boom'));
    const res = await handler(authedEvent({ awsAccountId: '111111111111' }));
    expect(res.statusCode).toBe(500);
  });

  it('saves the account as PENDING and returns a CloudFormation URL, tolerating an S3 policy failure', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(GetBucketPolicyCommand).rejects(new Error('access denied'));

    const res = await handler(authedEvent({ awsAccountId: '111111111111' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.connectionStatus).toBe('PENDING');
    expect(body.data.cfUrl).toContain('param_TenantId=tenant-123');
  });

  it('creates a fresh bucket policy when none exists yet', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(GetBucketPolicyCommand).rejects({ name: 'NoSuchBucketPolicy' });
    s3Mock.on(PutBucketPolicyCommand).resolves({});

    const res = await handler(authedEvent({ awsAccountId: '111111111111' }));
    expect(res.statusCode).toBe(200);

    const putCall = s3Mock.commandCalls(PutBucketPolicyCommand)[0].args[0].input;
    const policy = JSON.parse(putCall.Policy);
    expect(policy.Statement[0].Sid).toBe('tenant-tenant-123');
  });
});
