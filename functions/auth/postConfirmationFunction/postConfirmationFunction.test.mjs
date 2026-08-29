import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminAddUserToGroupCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { handler } from './index.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

const cognitoEvent = () => ({
  userPoolId: 'pool-1',
  userName: 'user-123',
  request: { userAttributes: { sub: 'tenant-123', email: 'a@b.com' } },
});

describe('postConfirmationFunction', () => {
  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
  });

  it('adds the user to the group, writes the tenant record, and returns the event', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const event = cognitoEvent();
    const result = await handler(event);

    expect(result).toBe(event);
    const putCall = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(putCall.Item.tenantId).toBe('tenant-123');
    expect(putCall.Item.connectionStatus).toBe('NOT_CONNECTED');
    expect(putCall.Item.planTier).toBe('free');
  });

  it('rolls back the Cognito user and throws if adding to the group fails', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).rejects(new Error('group missing'));
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    await expect(handler(cognitoEvent())).rejects.toThrow(/account removed/i);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('rolls back the Cognito user and throws if the DynamoDB write fails', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    ddbMock.on(PutCommand).rejects(new Error('ConditionalCheckFailedException'));
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    await expect(handler(cognitoEvent())).rejects.toThrow(/account removed/i);
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
  });
});
