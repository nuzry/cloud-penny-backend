import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/download'),
}));

const { handler } = await import('./index.mjs');

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const authedEvent = () => ({ requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-123' } } } } });

describe('getExportFiles', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
  });

  it('returns 401 with no tenant claim', async () => {
    const res = await handler({ requestContext: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the tenant does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(404);
  });

  it('returns an empty list when there are no CSV exports yet', async () => {
    ddbMock.on(GetCommand).resolves({ Item: {} });
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    const res = await handler(authedEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([]);
  });

  it('filters to .csv files and returns signed download URLs sorted newest first', async () => {
    ddbMock.on(GetCommand).resolves({ Item: {} });
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'tenant-123/query1.csv', LastModified: new Date('2026-08-01'), Size: 100 },
        { Key: 'tenant-123/query1.csv.metadata', LastModified: new Date('2026-08-01'), Size: 10 },
        { Key: 'tenant-123/query2.csv', LastModified: new Date('2026-08-05'), Size: 200 },
      ],
    });

    const res = await handler(authedEvent());
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].queryId).toBe('query2');
    expect(body.data[0].downloadUrl).toBe('https://signed.example/download');
  });
});
