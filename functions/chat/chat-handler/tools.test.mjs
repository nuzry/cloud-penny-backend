import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handleToolUse } from './tools.mjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TENANT = 'tenant-123';

describe('chat-handler tools', () => {
  beforeEach(() => ddbMock.reset());

  it('returns a friendly error for an unknown tool name instead of throwing', async () => {
    const result = await handleToolUse(ddbMock, TENANT, 'notARealTool', {});
    expect(result.error).toMatch(/not found/i);
  });

  describe('getMonthlySpend', () => {
    it('rejects a malformed month', async () => {
      const result = await handleToolUse(ddbMock, TENANT, 'getMonthlySpend', { month: 'August' });
      expect(result.noData).toBe(true);
    });

    it('reports noData when no snapshot exists for the month', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      const result = await handleToolUse(ddbMock, TENANT, 'getMonthlySpend', { month: '2026-08' });
      expect(result.noData).toBe(true);
    });

    it('returns the total cost on success', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { totalCost: 123.45, currency: 'USD' } });
      const result = await handleToolUse(ddbMock, TENANT, 'getMonthlySpend', { month: '2026-08' });
      expect(result.totalCost).toBe(123.45);
    });
  });

  describe('getSpendByService', () => {
    it('reports noData when no snapshot exists for the month', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      const result = await handleToolUse(ddbMock, TENANT, 'getSpendByService', { month: '2026-08' });
      expect(result.noData).toBe(true);
    });

    // Regression test: this tool used to return the raw {service: cost} map
    // and rely on the model to scan it for the largest value itself, which
    // produced wrong "top service" answers once costs were small, similarly
    // sized decimals. Sorting server-side and naming topService directly is
    // the fix, so this pins the sort order and the topService field.
    it('sorts services highest cost first and names topService explicitly', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          services: {
            AWSLambda: 0.000024,
            AmazonSES: 0.00064,
            AWSGlue: 0.837172,
            AmazonS3: 0.014901
          }
        }
      });
      const result = await handleToolUse(ddbMock, TENANT, 'getSpendByService', { month: '2026-08' });
      expect(result.services[0].service).toBe('AWSGlue');
      expect(result.services[result.services.length - 1].service).toBe('AWSLambda');
      expect(result.topService).toEqual({ service: 'AWSGlue', cost: 0.837172 });
    });
  });

  describe('getSpendByRegion', () => {
    it('notes when no per-region data is attached to the snapshot', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { totalCost: 10, regions: {} } });
      const result = await handleToolUse(ddbMock, TENANT, 'getSpendByRegion', { month: '2026-08' });
      expect(result.note).toBeDefined();
    });

    it('returns the region breakdown sorted highest first, with topRegion named', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { regions: { 'eu-west-1': 20, 'us-east-1': 80 } } });
      const result = await handleToolUse(ddbMock, TENANT, 'getSpendByRegion', { month: '2026-08' });
      expect(result.regions[0]).toEqual({ region: 'us-east-1', cost: 80 });
      expect(result.topRegion.region).toBe('us-east-1');
    });
  });

  describe('compareSpendPeriods', () => {
    it('computes absolute and percentage change between two months', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({ Item: { totalCost: 150 } })
        .resolvesOnce({ Item: { totalCost: 100 } });

      const result = await handleToolUse(ddbMock, TENANT, 'compareSpendPeriods', { currentMonth: '2026-08', previousMonth: '2026-07' });
      expect(result.absoluteChange).toBe(50);
      expect(result.percentageChange).toBe(50);
      expect(result.partialData).toBe(false);
    });

    it('flags partialData when only one side has a snapshot', async () => {
      ddbMock.on(GetCommand).resolvesOnce({ Item: { totalCost: 150 } }).resolvesOnce({ Item: undefined });
      const result = await handleToolUse(ddbMock, TENANT, 'compareSpendPeriods', { currentMonth: '2026-08', previousMonth: '2026-07' });
      expect(result.partialData).toBe(true);
      expect(result.previousCost).toBe(0);
    });
  });

  describe('getCostTrend', () => {
    it('rejects a range where startMonth is after endMonth', async () => {
      const result = await handleToolUse(ddbMock, TENANT, 'getCostTrend', { startMonth: '2026-08', endMonth: '2026-01' });
      expect(result.noData).toBe(true);
    });

    it('truncates a range longer than 12 months', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { totalCost: 10 } });
      const result = await handleToolUse(ddbMock, TENANT, 'getCostTrend', { startMonth: '2020-01', endMonth: '2030-01' });
      expect(result.trend.length).toBeLessThanOrEqual(12);
    });
  });

  describe('getTopCostDrivers', () => {
    it('ranks services by absolute cost change, ignoring sub-cent noise', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({ Item: { services: { AmazonEC2: 150, AmazonS3: 10.001 } } })
        .resolvesOnce({ Item: { services: { AmazonEC2: 100, AmazonS3: 10 } } });

      const result = await handleToolUse(ddbMock, TENANT, 'getTopCostDrivers', { currentMonth: '2026-08', previousMonth: '2026-07' });
      expect(result.topIncreases[0].service).toBe('AmazonEC2');
      expect(result.topIncreases.find(d => d.service === 'AmazonS3')).toBeUndefined(); // 0.001 change filtered out
    });
  });

  describe('getDailySpend', () => {
    it('rejects a range longer than 31 days', async () => {
      const result = await handleToolUse(ddbMock, TENANT, 'getDailySpend', { startDate: '2026-01-01', endDate: '2026-03-01' });
      expect(result.noData).toBe(true);
    });

    it('includes a per-day service breakdown only for short ranges', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ date: '2026-08-01', totalCost: 10, services: { AmazonEC2: 10 } }],
      });
      const result = await handleToolUse(ddbMock, TENANT, 'getDailySpend', { startDate: '2026-08-01', endDate: '2026-08-01' });
      expect(result.days[0].topServices).toBeDefined();
    });
  });

  describe('getTopOperationsForService', () => {
    it('requires a service name', async () => {
      const result = await handleToolUse(ddbMock, TENANT, 'getTopOperationsForService', { month: '2026-08' });
      expect(result.noData).toBe(true);
    });

    it('aggregates matching rows across days and caps at the top 10 operations', async () => {
      const dayItems = [];
      for (let i = 0; i < 15; i++) {
        dayItems.push({
          date: `2026-08-${String(i + 1).padStart(2, '0')}`,
          items: [{ service: 'AmazonEC2', operation: `Op${i}`, region: 'us-east-1', cost: i + 1, usageAmount: 1 }],
        });
      }
      ddbMock.on(QueryCommand).resolves({ Items: dayItems });

      const result = await handleToolUse(ddbMock, TENANT, 'getTopOperationsForService', { month: '2026-08', service: 'AmazonEC2' });
      expect(result.topOperations).toHaveLength(10);
      expect(result.serviceTotalCost).toBeCloseTo(120, 6); // sum 1..15
      expect(result.topOperations[0].operation).toBe('Op14'); // highest cost (15) first
    });

    it('reports noData when the service never appears in that month\'s data', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ date: '2026-08-01', items: [{ service: 'AmazonS3', operation: 'PutObject', cost: 1 }] }],
      });
      const result = await handleToolUse(ddbMock, TENANT, 'getTopOperationsForService', { month: '2026-08', service: 'AmazonEC2' });
      expect(result.noData).toBe(true);
    });
  });

  describe('getForecast', () => {
    it('reports noData when the month has no day items yet', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const result = await handleToolUse(ddbMock, TENANT, 'getForecast', { month: '2026-08' });
      expect(result.noData).toBe(true);
    });

    // Pins the exact (spend so far / days elapsed) * days in month formula,
    // matching the dashboard's own forecast card so the two can't disagree.
    it('projects month-end spend using (spend so far / days elapsed) * days in month', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { date: '2026-08-01', totalCost: 10 },
          { date: '2026-08-02', totalCost: 10 },
        ],
      });
      const result = await handleToolUse(ddbMock, TENANT, 'getForecast', { month: '2026-08' });
      expect(result.spendSoFar).toBe(20);
      expect(result.daysElapsed).toBe(2);
      expect(result.daysInMonth).toBe(31);
      expect(result.forecast).toBeCloseTo((20 / 2) * 31, 6);
    });

    it('defaults to the current month when none is given', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [{ date: '2026-08-01', totalCost: 5 }] });
      const result = await handleToolUse(ddbMock, TENANT, 'getForecast', {});
      expect(result.noData).toBeUndefined();
      expect(result.month).toMatch(/^\d{4}-\d{2}$/);
    });
  });

  describe('getRecentAlerts', () => {
    it('notes when there are no alerts on file', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const result = await handleToolUse(ddbMock, TENANT, 'getRecentAlerts', {});
      expect(result.alerts).toHaveLength(0);
      expect(result.note).toBeDefined();
    });

    it('returns alerts newest-first with the limit applied and capped at 20', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ createdAt: '2026-08-20T00:00:00Z', message: 'Spike in AmazonEC2', status: 'UNREAD' }],
      });
      const result = await handleToolUse(ddbMock, TENANT, 'getRecentAlerts', { limit: 999 });
      expect(result.alerts[0].message).toBe('Spike in AmazonEC2');
      const call = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(call.ScanIndexForward).toBe(false);
      expect(call.Limit).toBe(20);
    });
  });
});
