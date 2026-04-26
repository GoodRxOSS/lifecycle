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

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../MessageStore', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../RunExecutor', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../RunService', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../RunEventService', () => ({
  __esModule: true,
  default: {},
}));

import type { AgentUIMessage } from '../types';
import {
  applyApprovalResponsesToToolParts,
  normalizeUnavailableToolPartsForAgentInput,
} from '../LifecycleAiSdkHarness';

describe('applyApprovalResponsesToToolParts', () => {
  it('hydrates approved output tool parts so continuation messages validate', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'mcp__sandbox__workspace_write_file',
          toolCallId: 'call-1',
          state: 'output-error',
          input: {
            path: 'sample.txt',
            content: 'hello',
          },
          errorText: 'Session workspace gateway unavailable.',
          approval: {
            id: 'approval-1',
          },
        },
      ],
    } as AgentUIMessage;

    const result = applyApprovalResponsesToToolParts(
      message,
      new Map([
        [
          'approval-1',
          {
            approved: true,
            reason: 'Looks fine',
          },
        ],
      ])
    );

    expect(result.parts[0]).toEqual(
      expect.objectContaining({
        state: 'output-error',
        approval: {
          id: 'approval-1',
          approved: true,
          reason: 'Looks fine',
        },
      })
    );
  });

  it('marks pending approval parts as responded for resumed runs', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-mcp__sandbox__workspace_write_file',
          toolCallId: 'call-1',
          state: 'approval-requested',
          input: {
            path: 'sample.txt',
            content: 'hello',
          },
          approval: {
            id: 'approval-1',
          },
        },
      ],
    } as AgentUIMessage;

    const result = applyApprovalResponsesToToolParts(
      message,
      new Map([
        [
          'approval-1',
          {
            approved: false,
            reason: 'Not needed',
          },
        ],
      ])
    );

    expect(result.parts[0]).toEqual(
      expect.objectContaining({
        state: 'approval-responded',
        approval: {
          id: 'approval-1',
          approved: false,
          reason: 'Not needed',
        },
      })
    );
  });
});

describe('normalizeUnavailableToolPartsForAgentInput', () => {
  it('converts unavailable static tool parts to dynamic tool parts for continuation', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-mcp__sandbox__lifecycle__publish_http',
          toolCallId: 'call-1',
          state: 'output-error',
          errorText: 'Model tried to call unavailable tool.',
        },
      ],
    } as unknown as AgentUIMessage;

    const [result] = normalizeUnavailableToolPartsForAgentInput([message], {
      mcp__lifecycle__publish_http: {} as never,
    });

    expect(result.parts[0]).toEqual(
      expect.objectContaining({
        type: 'dynamic-tool',
        toolName: 'mcp__sandbox__lifecycle__publish_http',
        toolCallId: 'call-1',
        state: 'output-error',
        input: undefined,
      })
    );
  });
});
