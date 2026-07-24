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

jest.mock('server/models/AgentToolExecution');

import AgentToolExecution from 'server/models/AgentToolExecution';
import {
  extractDebugRepairCommitFromToolExecutions,
  extractDebugRepairCommitObservation,
} from '../debugRepairObservation';

const commitSha = '0123456789abcdef0123456789abcdef01234567';
const commitUrl = `https://github.com/example-org/example-repo/commit/${commitSha}`;

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

  it('reports a no-op update_file (changed=false) so callers can skip the rebuild watch', () => {
    const observation = extractDebugRepairCommitObservation(
      repairMessages({
        success: true,
        agentContent: JSON.stringify({ success: true, changed: false, commit_created: false }),
      })
    );

    expect(observation).toEqual({
      commitUrl: null,
      commitSha: null,
      changed: false,
      commitCreated: false,
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

    const observation = await extractDebugRepairCommitFromToolExecutions(307);

    expect(observation).toEqual({
      commitSha,
      commitUrl,
      changed: null,
      commitCreated: null,
    });
  });

  it('returns null from tool executions when nothing recorded a commit', async () => {
    (AgentToolExecution.query as jest.Mock).mockReturnValue({
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([]),
    });

    expect(await extractDebugRepairCommitFromToolExecutions(307)).toBeNull();
  });
});
