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

import type { Job } from 'bullmq';
import type { AgentEnvironmentWatchJob } from 'server/services/agent/EnvironmentWatchService';
import type { WorkspaceTemplateBuildRequest } from 'server/services/workspaceRuntime/templateBuild';
import { getLogContext } from 'server/lib/logger/context';
import { processAgentEnvironmentWatch } from '../agentEnvironmentWatch';
import { processWorkspaceTemplateBuild } from '../workspaceTemplateBuild';

const mockProcessWatchJob = jest.fn();
const mockRunWorkspaceTemplateBuild = jest.fn();

jest.mock('server/services/agent/EnvironmentWatchService', () => ({
  __esModule: true,
  default: {
    processWatchJob: (...args: unknown[]) => mockProcessWatchJob(...args),
  },
}));

jest.mock('server/services/workspaceRuntime/templateBuild', () => ({
  runWorkspaceTemplateBuild: (...args: unknown[]) => mockRunWorkspaceTemplateBuild(...args),
}));

const watchData: AgentEnvironmentWatchJob = {
  watchId: 'watch-1',
  buildUuid: 'build-1',
  threadUuid: 'thread-1',
  reason: 'repair_commit',
  pollCount: 3,
  deadlineAt: '2026-08-28T00:00:00.000Z',
  correlationId: 'correlation-1',
  sender: 'agent',
};

const templateBuildData: WorkspaceTemplateBuildRequest = {
  buildId: 'template-build-1',
  templateName: 'lifecycle-workspace',
  cpuCount: 2,
  memoryMB: 4_096,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockProcessWatchJob.mockResolvedValue(undefined);
  mockRunWorkspaceTemplateBuild.mockResolvedValue(undefined);
});

describe('processAgentEnvironmentWatch', () => {
  it('runs the watch service with the original job inside its payload context', async () => {
    const job = { data: watchData } as Job<AgentEnvironmentWatchJob>;
    let contextDuringWatch: Record<string, unknown> | undefined;
    mockProcessWatchJob.mockImplementation(async () => {
      contextDuringWatch = getLogContext();
    });

    await expect(processAgentEnvironmentWatch(job)).resolves.toBeUndefined();

    expect(contextDuringWatch).toMatchObject(watchData);
    expect(mockProcessWatchJob).toHaveBeenCalledWith(job);
  });

  it('propagates watch-service failures unchanged', async () => {
    const error = new Error('watch processing failed');
    const job = { data: watchData } as Job<AgentEnvironmentWatchJob>;
    mockProcessWatchJob.mockRejectedValue(error);

    await expect(processAgentEnvironmentWatch(job)).rejects.toBe(error);

    expect(mockProcessWatchJob).toHaveBeenCalledWith(job);
  });
});

describe('processWorkspaceTemplateBuild', () => {
  it('delegates the exact queue payload and resolves after the service completes', async () => {
    const job = { data: templateBuildData } as Job<WorkspaceTemplateBuildRequest>;

    await expect(processWorkspaceTemplateBuild(job)).resolves.toBeUndefined();

    expect(mockRunWorkspaceTemplateBuild).toHaveBeenCalledWith(templateBuildData);
  });

  it('propagates template-build failures unchanged', async () => {
    const error = new Error('template build failed');
    const job = { data: templateBuildData } as Job<WorkspaceTemplateBuildRequest>;
    mockRunWorkspaceTemplateBuild.mockRejectedValue(error);

    await expect(processWorkspaceTemplateBuild(job)).rejects.toBe(error);

    expect(mockRunWorkspaceTemplateBuild).toHaveBeenCalledWith(templateBuildData);
  });
});
