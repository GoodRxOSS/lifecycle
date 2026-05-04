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

import { NextRequest } from 'next/server';

const mockGetRequestUserIdentity = jest.fn();
const mockGetThreadAgentState = jest.fn();
const mockSwitchThreadAgent = jest.fn();

jest.mock('server/lib/get-user', () => ({
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
}));

jest.mock('server/services/agent/AgentSelectionService', () => {
  class AgentThreadAgentSwitchError extends Error {
    constructor(
      public readonly reason: string,
      message: string,
      public readonly details: Record<string, unknown> = {}
    ) {
      super(message);
      this.name = 'AgentThreadAgentSwitchError';
    }
  }

  return {
    __esModule: true,
    default: {
      getThreadAgentState: (...args: unknown[]) => mockGetThreadAgentState(...args),
      switchThreadAgent: (...args: unknown[]) => mockSwitchThreadAgent(...args),
    },
    AgentThreadAgentSwitchError,
  };
});

import { GET, PATCH } from './route';
import { AgentThreadAgentSwitchError } from 'server/services/agent/AgentSelectionService';

const agentState = {
  selectedId: null,
  defaultId: 'system.freeform',
  currentId: 'system.freeform',
  groups: [
    {
      id: 'built_in',
      label: 'Built in',
      agents: [
        { id: 'system.debug', ownerKind: 'system', label: 'Debug', group: 'built_in', available: true },
        { id: 'system.develop', ownerKind: 'system', label: 'Develop', group: 'built_in', available: false },
        { id: 'system.freeform', ownerKind: 'system', label: 'Free-form', group: 'built_in', available: true },
      ],
    },
    {
      id: 'my_agents',
      label: 'My agents',
      agents: [
        {
          id: 'custom.sample-agent',
          ownerKind: 'user',
          label: 'Sample custom agent',
          group: 'my_agents',
          available: true,
        },
      ],
    },
  ],
};

function makeRequest(body?: Record<string, unknown>): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body || {}),
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/ai/agent/threads/thread-1/agent'),
  } as unknown as NextRequest;
}

describe('/api/v2/ai/agent/threads/[threadId]/agent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-user',
      githubUsername: 'sample-user',
    });
    mockGetThreadAgentState.mockResolvedValue(agentState);
    mockSwitchThreadAgent.mockResolvedValue({
      previousAgent: agentState.groups[0].agents[2],
      nextAgent: agentState.groups[1].agents[0],
      switched: true,
      state: agentState,
    });
  });

  it('GET returns built_in and my_agents selection state', async () => {
    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetThreadAgentState).toHaveBeenCalledWith({
      threadId: 'thread-1',
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' },
    });
    expect(body.data.groups.map((group: { id: string }) => group.id)).toEqual(['built_in', 'my_agents']);
  });

  it('PATCH accepts only agentId and delegates the switch', async () => {
    const response = await PATCH(makeRequest({ agentId: 'custom.sample-agent' }), {
      params: { threadId: 'thread-1' },
    });

    expect(response.status).toBe(200);
    expect(mockSwitchThreadAgent).toHaveBeenCalledWith({
      threadId: 'thread-1',
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' },
      agentId: 'custom.sample-agent',
    });
  });

  it('returns 401 without identity', async () => {
    mockGetRequestUserIdentity.mockReturnValueOnce(null);

    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });

    expect(response.status).toBe(401);
  });

  it('returns 404 for non-owned thread/session errors', async () => {
    mockGetThreadAgentState.mockRejectedValueOnce(new Error('Agent thread not found'));

    const response = await GET(makeRequest(), { params: { threadId: 'thread-1' } });

    expect(response.status).toBe(404);
  });

  it('returns 400 for non-string or unsupported agent switch bodies', async () => {
    const response = await PATCH(makeRequest({ agentId: 'custom.sample-agent', another: true }), {
      params: { threadId: 'thread-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toContain('Unsupported switch request fields');

    const missingIdResponse = await PATCH(makeRequest({ agentId: 7 }), { params: { threadId: 'thread-1' } });
    expect(missingIdResponse.status).toBe(400);
  });

  it('returns 400 for another user or unknown custom agent ids', async () => {
    mockSwitchThreadAgent.mockRejectedValueOnce(new AgentThreadAgentSwitchError('unknown_agent', 'Unknown agent.'));

    const response = await PATCH(makeRequest({ agentId: 'custom.another-user-agent' }), {
      params: { threadId: 'thread-1' },
    });

    expect(response.status).toBe(400);
  });

  it('returns 409 for active run switch failures', async () => {
    mockSwitchThreadAgent.mockRejectedValueOnce(
      new AgentThreadAgentSwitchError('active_run', 'Wait for the current run to finish before switching agents.')
    );

    const response = await PATCH(makeRequest({ agentId: 'custom.sample-agent' }), {
      params: { threadId: 'thread-1' },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.message).toBe('Wait for the current run to finish before switching agents.');
  });
});
