import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client, GetBucketPolicyCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);
const s3Mock = mockClient(S3Client);

const authedEvent = (overrides = {}) => ({
  requestContext: {
    authorizer: { jwt: { claims: { sub: 'tenant-123', 'cognito:username': 'user-123' } } },
    http: { method: 'DELETE' },
  },
  ...overrides,
});

describe('deleteAccount', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
    s3Mock.reset();
    s3Mock.on(GetBucketPolicyCommand).rejects({ name: 'NoSuchBucketPolicy' });
  });

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: { http: { method: 'DELETE' } } });
    expect(res.statusCode).toBe(401);
  });

  describe('PUT (update settings)', () => {
    it('updates dailyRefreshQuota and returns 200', async () => {
      ddbMock.on(UpdateCommand).resolves({});
      const res = await handler(authedEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } }, http: { method: 'PUT' } },
        body: JSON.stringify({ dailyRefreshQuota: 5 }),
      }));
      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when no valid fields are provided', async () => {
      const res = await handler(authedEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } }, http: { method: 'PUT' } },
        body: JSON.stringify({}),
      }));
      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when the update fails', async () => {
      ddbMock.on(UpdateCommand).rejects(new Error('boom'));
      const res = await handler(authedEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } }, http: { method: 'PUT' } },
        body: JSON.stringify({ dailyRefreshQuota: 5 }),
      }));
      expect(res.statusCode).toBe(500);
    });
  });

  describe('DELETE (remove account)', () => {
    it('deletes the Cognito user and the tenant record on success', async () => {
      ddbMock.on(GetCommand).resolves({ Item: {} });
      ddbMock.on(DeleteCommand).resolves({});
      cognitoMock.on(AdminDeleteUserCommand).resolves({});

      const res = await handler(authedEvent());
      expect(res.statusCode).toBe(200);
      expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    it('proceeds to delete the DynamoDB record even if the Cognito user is already gone', async () => {
      ddbMock.on(GetCommand).resolves({ Item: {} });
      ddbMock.on(DeleteCommand).resolves({});
      cognitoMock.on(AdminDeleteUserCommand).rejects({ name: 'UserNotFoundException' });

      const res = await handler(authedEvent());
      expect(res.statusCode).toBe(200);
    });

    it('returns 500 if Cognito deletion fails for a real reason', async () => {
      ddbMock.on(GetCommand).resolves({ Item: {} });
      cognitoMock.on(AdminDeleteUserCommand).rejects({ name: 'InternalErrorException', message: 'nope' });

      const res = await handler(authedEvent());
      expect(res.statusCode).toBe(500);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    it('returns 500 if the DynamoDB delete fails after Cognito succeeded', async () => {
      ddbMock.on(GetCommand).resolves({ Item: {} });
      ddbMock.on(DeleteCommand).rejects(new Error('boom'));
      cognitoMock.on(AdminDeleteUserCommand).resolves({});

      const res = await handler(authedEvent());
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/cleanup is incomplete/i);
    });

    it('removes the matching S3 bucket policy statement when one exists', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { awsAccountId: '111111111111' } });
      ddbMock.on(DeleteCommand).resolves({});
      cognitoMock.on(AdminDeleteUserCommand).resolves({});
      s3Mock.on(GetBucketPolicyCommand).resolves({
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Sid: 'tenant-111111111111', Effect: 'Allow', Action: 's3:PutObject' }],
        }),
      });
      s3Mock.on(PutBucketPolicyCommand).resolves({});

      const res = await handler(authedEvent());
      expect(res.statusCode).toBe(200);
      expect(s3Mock.commandCalls(PutBucketPolicyCommand)).toHaveLength(1);
    });
  });
});
