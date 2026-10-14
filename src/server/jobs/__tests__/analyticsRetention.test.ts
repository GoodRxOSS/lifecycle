/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const mockGetConfig = jest.fn();
const mockRaw = jest.fn();
const mockInfo = jest.fn();
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getConfig: mockGetConfig }) },
}));
jest.mock('server/models/AuthAuditEvent', () => ({
  __esModule: true,
  default: { knex: () => ({ raw: mockRaw }) },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: mockInfo, warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  ANALYTICS_RETENTION_INTERVAL_MS,
  ANALYTICS_RETENTION_MAX_DAYS,
  processAnalyticsRetentionSweep,
  readAnalyticsRetention,
} from '../analyticsRetention';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
});
afterEach(() => jest.useRealTimers());

describe('readAnalyticsRetention', () => {
  it.each([
    ['missing config', undefined, { mcpToolCallDays: 0, buildEventDays: 0 }],
    ['zero keeps everything', { mcpToolCallDays: 0, buildEventDays: 0 }, { mcpToolCallDays: 0, buildEventDays: 0 }],
    [
      'negative and fractional',
      { mcpToolCallDays: -5, buildEventDays: 1.5 },
      { mcpToolCallDays: 0, buildEventDays: 0 },
    ],
    ['text', { mcpToolCallDays: 'soon' }, { mcpToolCallDays: 0, buildEventDays: 0 }],
    ['positive', { mcpToolCallDays: 30, buildEventDays: 400 }, { mcpToolCallDays: 30, buildEventDays: 400 }],
    [
      'capped',
      { mcpToolCallDays: 99999, buildEventDays: 99999 },
      { mcpToolCallDays: ANALYTICS_RETENTION_MAX_DAYS, buildEventDays: ANALYTICS_RETENTION_MAX_DAYS },
    ],
  ])('handles %s', async (_name, config, expected) => {
    mockGetConfig.mockResolvedValue(config);
    await expect(readAnalyticsRetention()).resolves.toEqual(expected);
    expect(mockGetConfig).toHaveBeenCalledWith('analytics_retention');
  });
});

describe('processAnalyticsRetentionSweep', () => {
  it('runs daily and does nothing while both retentions are off', async () => {
    expect(ANALYTICS_RETENTION_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    mockGetConfig.mockResolvedValue({ mcpToolCallDays: 0, buildEventDays: 0 });
    await expect(processAnalyticsRetentionSweep()).resolves.toEqual({ mcpToolCalls: 0, buildEvents: 0 });
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it('deletes only MCP tool calls and build events older than their cutoffs, in bounded batches', async () => {
    mockGetConfig.mockResolvedValue({ mcpToolCallDays: 30, buildEventDays: 7 });
    mockRaw
      .mockResolvedValueOnce({ rowCount: 5000 })
      .mockResolvedValueOnce({ rowCount: 12 })
      .mockResolvedValueOnce({ rowCount: 3 });
    await expect(processAnalyticsRetentionSweep()).resolves.toEqual({ mcpToolCalls: 5012, buildEvents: 3 });
    expect(mockRaw).toHaveBeenCalledTimes(3);
    expect(mockRaw.mock.calls[0][0]).toContain(`WHERE event = 'mcp.tool_call' AND "createdAt" < ? ORDER BY id LIMIT ?`);
    expect(mockRaw.mock.calls[0][1]).toEqual(['2026-09-12T12:00:00.000Z', 5000]);
    expect(mockRaw.mock.calls[2][0]).toContain('DELETE FROM build_events WHERE id IN');
    expect(mockRaw.mock.calls[2][1]).toEqual(['2026-10-05T12:00:00.000Z', 5000]);
    expect(mockInfo).toHaveBeenCalledWith(
      { retention: { mcpToolCallDays: 30, buildEventDays: 7 }, mcpToolCalls: 5012, buildEvents: 3 },
      'Analytics: retention sweep deleted records'
    );
  });

  it('stays quiet when nothing is old enough', async () => {
    mockGetConfig.mockResolvedValue({ mcpToolCallDays: 7 });
    mockRaw.mockResolvedValueOnce({});
    await expect(processAnalyticsRetentionSweep()).resolves.toEqual({ mcpToolCalls: 0, buildEvents: 0 });
    expect(mockInfo).not.toHaveBeenCalled();
  });
});
