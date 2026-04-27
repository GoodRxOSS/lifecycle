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
    transaction: jest.fn(),
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/services/agent/MessageStore', () => ({
  __esModule: true,
  default: {
    findCanonicalMessageByClientMessageId: jest.fn(),
    insertUserMessageForRun: jest.fn(),
  },
}));

jest.mock('server/services/agent/RunEventService', () => ({
  __esModule: true,
  default: {
    appendStatusEvent: jest.fn(),
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

import AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import AgentMessageStore from '../MessageStore';
import AgentRunAdmissionService from '../RunAdmissionService';
import AgentRunEventService from '../RunEventService';

const mockRunQuery = AgentRun.query as jest.Mock;
const mockRunTransaction = AgentRun.transaction as jest.Mock;
const mockSessionQuery = AgentSession.query as jest.Mock;
const mockThreadQuery = AgentThread.query as jest.Mock;
const mockFindCanonicalMessageByClientMessageId = AgentMessageStore.findCanonicalMessageByClientMessageId as jest.Mock;
const mockInsertUserMessageForRun = AgentMessageStore.insertUserMessageForRun as jest.Mock;
const mockAppendStatusEvent = AgentRunEventService.appendStatusEvent as jest.Mock;

function buildActiveRunQuery(activeRun: unknown = null) {
  const query = {
    where: jest.fn(),
    whereNotIn: jest.fn(),
    orderBy: jest.fn(),
    first: jest.fn().mockResolvedValue(activeRun),
  };
  query.where.mockReturnValue(query);
  query.whereNotIn.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return query;
}

describe('AgentRunAdmissionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTransaction.mockImplementation(async (callback) => callback({ trx: true }));
    mockSessionQuery.mockReturnValue({
      findById: jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue({}),
      }),
    });
    mockThreadQuery.mockReturnValue({
      patchAndFetchById: jest.fn().mockResolvedValue({}),
    });
    mockFindCanonicalMessageByClientMessageId.mockResolvedValue(undefined);
    mockInsertUserMessageForRun.mockResolvedValue({ id: 31, uuid: 'message-1' });
    mockAppendStatusEvent.mockResolvedValue(undefined);
  });

  it('persists submitted message and queued run in the same transaction', async () => {
    const queuedRun = {
      id: 23,
      uuid: 'run-1',
      status: 'queued',
    };
    const activeRunQuery = buildActiveRunQuery();
    const insertRunQuery = {
      insertAndFetch: jest.fn().mockResolvedValue(queuedRun),
    };
    mockRunQuery.mockReturnValueOnce(activeRunQuery).mockReturnValueOnce(insertRunQuery);

    const admission = await AgentRunAdmissionService.createQueuedRunWithMessage({
      thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['thread'],
      session: { id: 17, uuid: 'session-1' } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['session'],
      policy: { defaultMode: 'require_approval', rules: {} } as any,
      message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
      runtimeOptions: { maxIterations: 12 },
    });

    expect(admission).toEqual({
      run: queuedRun,
      message: { id: 31, uuid: 'message-1' },
      created: true,
    });
    expect(mockInsertUserMessageForRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, uuid: 'thread-1' }),
      queuedRun,
      { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
      { trx: true }
    );
    expect(insertRunQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 7,
        sessionId: 17,
        status: 'queued',
        resolvedHarness: 'lifecycle_ai_sdk',
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
        policySnapshot: expect.objectContaining({
          runtimeOptions: { maxIterations: 12 },
        }),
      })
    );
    expect(mockAppendStatusEvent).toHaveBeenCalledWith('run-1', 'run.queued', {
      threadId: 'thread-1',
      sessionId: 'session-1',
    });
  });

  it('does not persist messages when another run is active', async () => {
    const activeRunQuery = buildActiveRunQuery({ id: 99, uuid: 'run-active' });
    mockRunQuery.mockReturnValueOnce(activeRunQuery);

    await expect(
      AgentRunAdmissionService.createQueuedRunWithMessage({
        thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
          typeof AgentRunAdmissionService.createQueuedRunWithMessage
        >[0]['thread'],
        session: { id: 17, uuid: 'session-1' } as Parameters<
          typeof AgentRunAdmissionService.createQueuedRunWithMessage
        >[0]['session'],
        policy: { defaultMode: 'require_approval', rules: {} } as any,
        message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
        resolvedHarness: 'lifecycle_ai_sdk',
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
      })
    ).rejects.toThrow('Wait for the current agent run to finish before starting another run.');

    expect(mockInsertUserMessageForRun).not.toHaveBeenCalled();
    expect(mockAppendStatusEvent).not.toHaveBeenCalled();
  });

  it('returns the existing run for duplicate client message ids', async () => {
    const existingMessage = {
      id: 31,
      uuid: 'message-1',
      runId: 23,
    };
    const existingRun = {
      id: 23,
      uuid: 'run-1',
      status: 'queued',
    };
    const findRunQuery = {
      findById: jest.fn().mockResolvedValue(existingRun),
    };
    mockFindCanonicalMessageByClientMessageId.mockResolvedValueOnce(existingMessage);
    mockRunQuery.mockReturnValueOnce(findRunQuery);

    const admission = await AgentRunAdmissionService.createQueuedRunWithMessage({
      thread: { id: 7, uuid: 'thread-1', metadata: {} } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['thread'],
      session: { id: 17, uuid: 'session-1' } as Parameters<
        typeof AgentRunAdmissionService.createQueuedRunWithMessage
      >[0]['session'],
      policy: { defaultMode: 'require_approval', rules: {} } as any,
      message: { clientMessageId: 'client-message-1', parts: [{ type: 'text', text: 'Hi' }] },
      resolvedHarness: 'lifecycle_ai_sdk',
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
    });

    expect(admission).toEqual({
      run: existingRun,
      message: existingMessage,
      created: false,
    });
    expect(mockInsertUserMessageForRun).not.toHaveBeenCalled();
    expect(mockAppendStatusEvent).not.toHaveBeenCalled();
  });
});
