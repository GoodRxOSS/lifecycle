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

jest.mock('ai', () => ({
  __esModule: true,
  getToolName: jest.fn(() => 'tool'),
  isToolUIPart: jest.fn((part) => !!part && typeof part === 'object' && 'state' in part),
}));

jest.mock('server/models/AgentPendingAction', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('../ThreadService', () => ({
  __esModule: true,
  default: {
    getOwnedThread: jest.fn(),
  },
}));

import AgentPendingAction from 'server/models/AgentPendingAction';
import ApprovalService from '../ApprovalService';
import AgentThreadService from '../ThreadService';

const mockPendingActionQuery = AgentPendingAction.query as jest.Mock;
const mockGetOwnedThread = AgentThreadService.getOwnedThread as jest.Mock;

describe('ApprovalService.serializePendingAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('omits the unused expiresAt field from API output', () => {
    const serialized = ApprovalService.serializePendingAction({
      uuid: 'action-1',
      threadId: 3,
      runId: 4,
      kind: 'tool_approval',
      status: 'pending',
      capabilityKey: 'external_mcp_write',
      title: 'Approve tool',
      description: 'Tool requires approval',
      payload: { approvalId: 'approval-1' },
      resolution: null,
      expiresAt: '2026-04-12T00:00:00.000Z',
      resolvedAt: null,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    } as any);

    expect(serialized).toEqual({
      id: 'action-1',
      threadId: '3',
      runId: '4',
      kind: 'tool_approval',
      status: 'pending',
      capabilityKey: 'external_mcp_write',
      title: 'Approve tool',
      description: 'Tool requires approval',
      payload: { approvalId: 'approval-1' },
      resolution: null,
      resolvedAt: null,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    });
  });

  it('queries approval responses through the action alias before resolving the pending action', async () => {
    mockGetOwnedThread.mockResolvedValue({ id: 7 });

    const pendingLookupQuery: any = {};
    pendingLookupQuery.alias = jest.fn().mockReturnValue(pendingLookupQuery);
    pendingLookupQuery.joinRelated = jest.fn().mockReturnValue(pendingLookupQuery);
    pendingLookupQuery.where = jest.fn().mockReturnValue(pendingLookupQuery);
    pendingLookupQuery.whereRaw = jest.fn().mockReturnValue(pendingLookupQuery);
    pendingLookupQuery.modify = jest.fn((callback) => {
      callback(pendingLookupQuery);
      return pendingLookupQuery;
    });
    pendingLookupQuery.select = jest.fn().mockReturnValue(pendingLookupQuery);
    pendingLookupQuery.orderBy = jest.fn().mockReturnValue(pendingLookupQuery);
    pendingLookupQuery.first = jest.fn().mockResolvedValue({ id: 99 });

    const patchQuery = {
      patchAndFetchById: jest.fn().mockResolvedValue(undefined),
    };

    mockPendingActionQuery.mockImplementationOnce(() => pendingLookupQuery).mockImplementationOnce(() => patchQuery);

    await ApprovalService.syncApprovalResponsesFromMessages('thread-uuid', 'sample-user', [
      {
        metadata: { runId: 'run-uuid' },
        parts: [
          {
            state: 'approval-responded',
            toolCallId: 'tool-call-1',
            approval: {
              id: 'approval-1',
              approved: true,
              reason: 'approved in UI',
            },
          },
        ],
      } as any,
    ]);

    expect(pendingLookupQuery.alias).toHaveBeenCalledWith('action');
    expect(pendingLookupQuery.whereRaw).toHaveBeenNthCalledWith(1, `action.payload->>'approvalId' = ?`, ['approval-1']);
    expect(pendingLookupQuery.whereRaw).toHaveBeenNthCalledWith(2, `action.payload->>'toolCallId' = ?`, [
      'tool-call-1',
    ]);
    expect(pendingLookupQuery.where).toHaveBeenCalledWith('run.uuid', 'run-uuid');
    expect(patchQuery.patchAndFetchById).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        status: 'approved',
        resolution: {
          approved: true,
          reason: 'approved in UI',
          source: 'message',
        },
      })
    );
  });
});
