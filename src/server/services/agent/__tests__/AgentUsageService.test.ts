/**
 * Copyright 2026 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThreadWithSession: jest.fn(),
    getOwnedSession: jest.fn(),
  },
}));

import AgentRun from 'server/models/AgentRun';
import AgentThreadService from '../ThreadService';
import AgentUsageService, { type AgentUsageRunRecord } from '../AgentUsageService';

const mockRunQuery = AgentRun.query as jest.Mock;
const mockGetOwnedThreadWithSession = AgentThreadService.getOwnedThreadWithSession as jest.Mock;
const mockGetOwnedSession = AgentThreadService.getOwnedSession as jest.Mock;

function buildRun(overrides: Partial<AgentUsageRunRecord> = {}): AgentUsageRunRecord {
  return {
    status: 'completed',
    resolvedProvider: 'openai',
    resolvedModel: 'gpt-5.4',
    provider: 'openai',
    model: 'gpt-5.4',
    usageSummary: {},
    ...overrides,
  };
}

function buildRunQuery(rows: AgentUsageRunRecord[]) {
  const query = {
    where: jest.fn(),
    orderBy: jest.fn(),
  };
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValueOnce(query).mockResolvedValueOnce(rows);
  return query;
}

describe('AgentUsageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses exact provider totals and exact input plus output totals only', () => {
    const aggregate = AgentUsageService.aggregateRuns([
      buildRun({
        usageSummary: {
          totalTokens: 120,
          inputTokens: 80,
          outputTokens: 30,
          reasoningTokens: 10,
          cachedInputTokens: 20,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 20,
          nonCachedInputTokens: 55,
          textOutputTokens: 20,
          rawUsage: { provider: 'hidden' },
          providerMetadata: { requestId: 'hidden' },
        },
      }),
      buildRun({
        usageSummary: {
          inputTokens: 40,
          outputTokens: 15,
        },
      }),
      buildRun({
        usageSummary: {
          inputTokens: 25,
        },
      }),
    ]);

    expect(aggregate.usageSummary).toEqual({
      totalTokens: 175,
      inputTokens: 145,
      outputTokens: 45,
      reasoningTokens: 10,
      cachedInputTokens: 20,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 20,
      nonCachedInputTokens: 55,
      textOutputTokens: 20,
    });
    expect(aggregate.usageCompleteness).toEqual({
      runCount: 3,
      reportedRunCount: 2,
      missingUsageRunCount: 1,
      complete: false,
    });
    expect(JSON.stringify(aggregate)).not.toContain('rawUsage');
    expect(JSON.stringify(aggregate)).not.toContain('providerMetadata');
  });

  it('attributes usage by resolved provider and model with legacy fallback', () => {
    const aggregate = AgentUsageService.aggregateRuns([
      buildRun({
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
        provider: 'gateway',
        model: 'provider-response-id',
        usageSummary: {
          totalTokens: 10,
          inputTokens: 6,
          outputTokens: 4,
        },
      }),
      buildRun({
        resolvedProvider: null,
        resolvedModel: null,
        provider: 'anthropic',
        model: 'claude-sonnet-4.6',
        usageSummary: {
          totalTokens: 20,
          inputTokens: 14,
          outputTokens: 6,
        },
      }),
    ]);

    expect(aggregate.usageByModel).toEqual([
      {
        provider: 'openai',
        model: 'gpt-5.4',
        totalTokens: 10,
        inputTokens: 6,
        outputTokens: 4,
        runCount: 1,
        reportedRunCount: 1,
        missingUsageRunCount: 0,
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4.6',
        totalTokens: 20,
        inputTokens: 14,
        outputTokens: 6,
        runCount: 1,
        reportedRunCount: 1,
        missingUsageRunCount: 0,
      },
    ]);
  });

  it('applies status-specific missing usage rules', () => {
    const aggregate = AgentUsageService.aggregateRuns([
      buildRun({ status: 'queued' }),
      buildRun({ status: 'starting' }),
      buildRun({ status: 'running' }),
      buildRun({ status: 'waiting_for_approval' }),
      buildRun({
        status: 'waiting_for_input',
        usageSummary: {
          inputTokens: 12,
        },
      }),
      buildRun({
        status: 'failed',
        usageSummary: {
          totalTokens: 9,
        },
      }),
      buildRun({
        status: 'cancelled',
        usageSummary: {
          inputTokens: 5,
          outputTokens: 3,
        },
      }),
      buildRun({ status: 'completed' }),
    ]);

    expect(aggregate.usageSummary.totalTokens).toBe(17);
    expect(aggregate.usageSummary.inputTokens).toBe(17);
    expect(aggregate.usageSummary.outputTokens).toBe(3);
    expect(aggregate.usageCompleteness).toEqual({
      runCount: 8,
      reportedRunCount: 2,
      missingUsageRunCount: 3,
      complete: false,
    });
    expect(aggregate.usageByModel[0]).toEqual(
      expect.objectContaining({
        runCount: 8,
        reportedRunCount: 2,
        missingUsageRunCount: 3,
      })
    );
  });

  it('counts zero exact totals as reported usage for completeness', () => {
    const aggregate = AgentUsageService.aggregateRuns([
      buildRun({
        usageSummary: {
          totalTokens: 0,
        },
      }),
    ]);

    expect(aggregate.usageSummary.totalTokens).toBe(0);
    expect(aggregate.usageCompleteness).toEqual({
      runCount: 1,
      reportedRunCount: 1,
      missingUsageRunCount: 0,
      complete: true,
    });
  });

  it('verifies thread ownership before aggregating thread usage', async () => {
    const runs = [
      buildRun({
        usageSummary: {
          totalTokens: 13,
        },
      }),
    ];
    const query = buildRunQuery(runs);
    mockGetOwnedThreadWithSession.mockResolvedValue({
      thread: { id: 7, uuid: 'thread-1' },
      session: { id: 17, uuid: 'session-1' },
    });
    mockRunQuery.mockReturnValueOnce(query);

    const usage = await AgentUsageService.getOwnedThreadUsage('thread-1', 'sample-user');

    expect(mockGetOwnedThreadWithSession).toHaveBeenCalledWith('thread-1', 'sample-user');
    expect(query.where).toHaveBeenCalledWith({ threadId: 7 });
    expect(usage).toEqual(
      expect.objectContaining({
        threadId: 'thread-1',
        sessionId: 'session-1',
        usageSummary: { totalTokens: 13 },
      })
    );
  });

  it('exposes a session aggregate without filtering archived threads', async () => {
    const runs = [
      buildRun({
        usageSummary: {
          totalTokens: 21,
        },
      }),
    ];
    const query = buildRunQuery(runs);
    mockGetOwnedSession.mockResolvedValue({
      id: 17,
      uuid: 'session-1',
    });
    mockRunQuery.mockReturnValueOnce(query);

    const usage = await AgentUsageService.getOwnedSessionUsage('session-1', 'sample-user');

    expect(mockGetOwnedSession).toHaveBeenCalledWith('session-1', 'sample-user');
    expect(query.where).toHaveBeenCalledWith({ sessionId: 17 });
    expect(usage).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        usageSummary: { totalTokens: 21 },
      })
    );
  });

  it('aggregates multiple session usage records with one run query', async () => {
    const runs = [
      buildRun({
        sessionId: 17,
        usageSummary: {
          totalTokens: 21,
        },
      }),
      buildRun({
        sessionId: 18,
        usageSummary: {
          inputTokens: 9,
          outputTokens: 4,
        },
      }),
      buildRun({
        sessionId: 18,
        status: 'completed',
        usageSummary: {},
      }),
    ];
    const query = {
      whereIn: jest.fn(),
      orderBy: jest.fn(),
    };
    query.whereIn.mockReturnValue(query);
    query.orderBy.mockReturnValueOnce(query).mockReturnValueOnce(query).mockResolvedValueOnce(runs);
    mockRunQuery.mockReturnValueOnce(query);

    const usageBySessionId = await AgentUsageService.aggregateSessionsUsage([17, 18, 19]);

    expect(mockRunQuery).toHaveBeenCalledTimes(1);
    expect(query.whereIn).toHaveBeenCalledWith('sessionId', [17, 18, 19]);
    expect(usageBySessionId.get(17)?.usageSummary).toEqual({ totalTokens: 21 });
    expect(usageBySessionId.get(18)?.usageSummary).toEqual({
      totalTokens: 13,
      inputTokens: 9,
      outputTokens: 4,
    });
    expect(usageBySessionId.get(18)?.usageCompleteness).toEqual({
      runCount: 2,
      reportedRunCount: 1,
      missingUsageRunCount: 1,
      complete: false,
    });
    expect(usageBySessionId.get(19)).toEqual({
      usageSummary: { totalTokens: 0 },
      usageByModel: [],
      usageCompleteness: {
        runCount: 0,
        reportedRunCount: 0,
        missingUsageRunCount: 0,
        complete: true,
      },
    });
  });
});
