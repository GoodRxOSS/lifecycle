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

jest.mock('server/models/Build');
jest.mock('server/models/AgentToolExecution');

import AgentToolExecution from 'server/models/AgentToolExecution';
import Build from 'server/models/Build';
import { BuildStatus, DeployStatus } from 'shared/constants';
import { buildDebugRepairObservationText, extractDebugRepairCommitObservation } from '../debugRepairObservation';
import type { AgentRunPlanSnapshotV1 } from '../runPlanTypes';

const commitSha = '0123456789abcdef0123456789abcdef01234567';
const commitUrl = `https://github.com/example-org/example-repo/commit/${commitSha}`;

function repairRunPlan(): AgentRunPlanSnapshotV1 {
  return {
    version: 1,
    capturedAt: '2026-05-08T00:00:00.000Z',
    agent: {
      id: 'system.debug',
      label: 'Debug',
      sourceKind: 'build_context_chat',
    },
    source: {
      buildUuid: 'sample-build-1',
      freshness: {
        capturedAt: '2026-05-08T00:00:00.000Z',
        freshnessSource: 'source',
      },
    },
    model: {
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
    },
    runtime: {
      resolvedHarness: 'lifecycle_ai_sdk',
      sandboxRequirement: {},
      runtimeOptions: {},
      approvalPolicy: {
        defaultMode: 'require_approval',
        rules: { read: 'allow' },
      },
    },
    prompt: {
      instructionRefs: [],
      renderedSummary: 'Debug',
      renderedHash: 'sha256:debug',
    },
    capabilities: {
      provisionalCapabilityIds: [],
      resolvedCapabilityAccess: [],
    },
    debug: {
      requestedIntent: 'repair',
      resolvedIntent: 'repair',
      decisionSource: 'client_request',
      reasonCode: 'explicit_repair_after_diagnosis',
    },
    warnings: [],
  };
}

function repairMessages(output: unknown) {
  return [
    {
      id: 'assistant-1',
      role: 'assistant',
      metadata: { runId: 'run-1' },
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'mcp__lifecycle__update_file',
          toolCallId: 'tool-1',
          state: 'output-available',
          output,
        },
      ],
    },
  ] as any;
}

describe('debugRepairObservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('extracts commit metadata from approved update_file tool output', () => {
    const observation = extractDebugRepairCommitObservation(
      repairMessages({
        success: true,
        agentContent: JSON.stringify({
          success: true,
          commit_sha: commitSha,
          commit_url: commitUrl,
        }),
      })
    );

    expect(observation).toEqual({
      commitSha,
      commitUrl,
      changed: null,
      commitCreated: null,
    });
  });

  it('extracts commit metadata from an AI SDK static tool part (typed tool-<name>, no toolName property)', () => {
    const observation = extractDebugRepairCommitObservation([
      {
        id: 'assistant-1',
        role: 'assistant',
        metadata: { runId: 'run-1' },
        parts: [
          {
            type: 'tool-mcp__lifecycle__update_file',
            toolCallId: 'tool-1',
            state: 'output-available',
            output: {
              success: true,
              agentContent: JSON.stringify({
                success: true,
                commit_sha: commitSha,
                commit_url: commitUrl,
              }),
            },
          },
        ],
      },
    ] as any);

    expect(observation).toEqual({
      commitSha,
      commitUrl,
      changed: null,
      commitCreated: null,
    });
  });

  it('extracts a plain commit URL from markdown-wrapped commit text', () => {
    const observation = extractDebugRepairCommitObservation(
      repairMessages({
        success: true,
        displayContent: `Repair applied: [0123456](${commitUrl})`,
      })
    );

    expect(observation).toEqual({
      commitSha,
      commitUrl,
      changed: null,
      commitCreated: null,
    });
  });

  it('falls back to recorded tool executions when messages carry no tool parts', async () => {
    (AgentToolExecution.query as jest.Mock).mockReturnValue({
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([
        {
          toolName: 'update_file',
          status: 'completed',
          result: {
            value: {
              success: true,
              agentContent: JSON.stringify({
                success: true,
                commit_sha: commitSha,
                commit_url: commitUrl,
              }),
            },
          },
        },
      ]),
    });
    (Build.query as jest.Mock).mockReturnValue({
      findOne: jest.fn().mockReturnValue({
        withGraphFetched: jest.fn().mockResolvedValue({
          uuid: 'sample-build-1',
          status: BuildStatus.DEPLOYED,
          statusMessage: '',
          sha: commitSha,
          pullRequest: {
            latestCommit: commitSha,
          },
          deploys: [],
        }),
      }),
    });

    const text = await buildDebugRepairObservationText({
      session: {
        buildUuid: 'sample-build-1',
        selectedServices: [],
      } as any,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          metadata: { runId: 'run-1' },
          parts: [{ type: 'text', text: 'I have updated grpc-echo/Dockerfile.' }],
        },
      ] as any,
      runPlanSnapshot: repairRunPlan(),
      runId: 307,
    });

    expect(text).toContain(`Commit: ${commitUrl}`);
    expect(text).toContain('the environment is deployed');
  });

  it('returns null without a runId when messages carry no tool parts', async () => {
    const text = await buildDebugRepairObservationText({
      session: { buildUuid: 'sample-build-1', selectedServices: [] } as any,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          metadata: { runId: 'run-1' },
          parts: [{ type: 'text', text: 'I have updated grpc-echo/Dockerfile.' }],
        },
      ] as any,
      runPlanSnapshot: repairRunPlan(),
    });

    expect(text).toBeNull();
    expect(AgentToolExecution.query).not.toHaveBeenCalled();
  });

  it('summarizes fresh terminal environment state after a repair commit', async () => {
    (Build.query as jest.Mock).mockReturnValue({
      findOne: jest.fn().mockReturnValue({
        withGraphFetched: jest.fn().mockResolvedValue({
          uuid: 'sample-build-1',
          status: BuildStatus.ERROR,
          statusMessage: 'Deployment failed',
          sha: commitSha,
          pullRequest: {
            latestCommit: commitSha,
          },
          deploys: [
            {
              uuid: 'sample-service-sample-build-1',
              status: DeployStatus.DEPLOY_FAILED,
              statusMessage: 'Deployment failed',
              sha: commitSha,
              deployable: { name: 'sample-service' },
              service: null,
            },
          ],
        }),
      }),
    });

    const text = await buildDebugRepairObservationText({
      session: {
        buildUuid: 'sample-build-1',
        selectedServices: [
          {
            deployUuid: 'sample-service-sample-build-1',
            deployStatus: DeployStatus.BUILD_FAILED,
          },
        ],
      } as any,
      messages: repairMessages({
        agentContent: JSON.stringify({
          success: true,
          commit_sha: commitSha,
          commit_url: commitUrl,
        }),
      }),
      runPlanSnapshot: repairRunPlan(),
    });

    expect(text).toContain(`Commit: ${commitUrl}`);
    expect(text).toContain('Lifecycle picked up the repair commit');
    expect(text).toContain('terminal status=error');
    expect(text).toContain('Selected service moved from status=build_failed to status=deploy_failed');
    expect(text).toContain('Current blocker: sample-service status=deploy_failed');
  });

  it('waits briefly for webhook activity before reporting the repair state', async () => {
    let now = 0;
    const sleep = jest.fn().mockImplementation(async (durationMs: number) => {
      now += durationMs;
    });

    (Build.query as jest.Mock)
      .mockImplementationOnce(() => ({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue({
            uuid: 'sample-build-1',
            status: BuildStatus.ERROR,
            statusMessage: 'Build failed',
            sha: 'abc123',
            pullRequest: {
              latestCommit: 'abc123',
            },
            updatedAt: '2026-05-08T00:00:00.000Z',
            deploys: [],
          }),
        }),
      }))
      .mockImplementationOnce(() => ({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue({
            uuid: 'sample-build-1',
            status: BuildStatus.DEPLOYING,
            statusMessage: '',
            sha: 'abc123',
            pullRequest: {
              latestCommit: 'abc123',
            },
            updatedAt: '2026-05-08T00:00:30.000Z',
            deploys: [],
          }),
        }),
      }));

    const text = await buildDebugRepairObservationText({
      session: { buildUuid: 'sample-build-1' } as any,
      messages: repairMessages({
        agentContent: JSON.stringify({
          success: true,
          commit_sha: commitSha,
          commit_url: commitUrl,
        }),
      }),
      runPlanSnapshot: repairRunPlan(),
      poll: {
        timeoutMs: 1000,
        intervalMs: 1000,
        sleep,
        now: () => now,
      },
    });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(text).toContain(`Commit: ${commitUrl}`);
    expect(text).toContain('Lifecycle picked up the repair commit');
    expect(text).toContain('status=deploying');
    expect(text).not.toContain('has not shown up');
  });

  it('does not imply a webhook rebuild when update_file was a no-op', async () => {
    const text = await buildDebugRepairObservationText({
      session: { buildUuid: 'sample-build-1' } as any,
      messages: repairMessages({
        agentContent: JSON.stringify({
          success: true,
          changed: false,
          commit_created: false,
        }),
      }),
      runPlanSnapshot: repairRunPlan(),
    });

    expect(text).toContain('no repair commit was created');
    expect(text).toContain('no webhook rebuild should be expected');
    expect(Build.query).not.toHaveBeenCalled();
  });
});
