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

const mockBuildFindOne = jest.fn();
const mockQueueAdd = jest.fn();
const mockScheduleEnvironmentWatch = jest.fn();

jest.mock('server/models/Build', () => ({
  __esModule: true,
  default: {
    query: () => ({ findOne: mockBuildFindOne }),
  },
}));

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: class MockBuildService {
    resolveAndDeployBuildQueue = { add: mockQueueAdd };
  },
}));

jest.mock('server/services/agent/EnvironmentWatchService', () => ({
  __esModule: true,
  default: {
    scheduleEnvironmentWatch: (...args: unknown[]) => mockScheduleEnvironmentWatch(...args),
  },
}));

import { TriggerRedeployTool } from '../triggerRedeploy';

describe('TriggerRedeployTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildFindOne.mockResolvedValue({ id: 11, status: 'deployed' });
    mockQueueAdd.mockResolvedValue(undefined);
    mockScheduleEnvironmentWatch.mockResolvedValue({ scheduled: true });
  });

  it('fails closed without an allowed build', async () => {
    const tool = new TriggerRedeployTool();

    const result = await tool.execute({ reason: 'transient failure' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('BUILD_NOT_ALLOWED');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('schedules the watch against the initiating thread, not the lastActivity heuristic', async () => {
    const tool = new TriggerRedeployTool();
    tool.setAllowedBuildUuid('build-1');
    tool.setWatchTarget({ threadUuid: 'thread-1', sessionUuid: 'session-1' });

    const result = await tool.execute({ reason: 'transient failure' });

    expect(result.success).toBe(true);
    expect(mockScheduleEnvironmentWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        buildUuid: 'build-1',
        reason: 'trigger_redeploy',
        threadUuid: 'thread-1',
        sessionUuid: 'session-1',
      })
    );
  });

  it('falls back to service-side target resolution when no thread context was wired', async () => {
    const tool = new TriggerRedeployTool();
    tool.setAllowedBuildUuid('build-1');

    await tool.execute({ reason: 'transient failure' });

    const input = mockScheduleEnvironmentWatch.mock.calls[0][0];
    expect(input.threadUuid).toBeUndefined();
  });
});
