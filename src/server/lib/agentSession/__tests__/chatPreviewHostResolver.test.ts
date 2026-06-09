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

jest.mock('server/models/AgentSandboxExposure', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentSandbox', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

import AgentSandbox from 'server/models/AgentSandbox';
import AgentSandboxExposure from 'server/models/AgentSandboxExposure';
import AgentSession from 'server/models/AgentSession';
import { resolveChatPreviewSessionForHost } from '../chatPreviewHostResolver';

const mockExposureQuery = AgentSandboxExposure.query as jest.Mock;
const mockSandboxQuery = AgentSandbox.query as jest.Mock;
const mockSessionQuery = AgentSession.query as jest.Mock;

const hostMatch = {
  port: 3000,
  previewSlug: 'abcdef1234567890abcdef1234567890',
  host: '3000--abcdef1234567890abcdef1234567890.localhost:5001',
};

function exposureQueryResult(exposure: Record<string, unknown> | null) {
  const query: Record<string, jest.Mock> = {};
  query.where = jest.fn(() => query);
  query.whereRaw = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.first = jest.fn().mockResolvedValue(exposure);
  mockExposureQuery.mockReturnValueOnce(query);
  return query;
}

function sandboxQueryResult(sandbox: Record<string, unknown> | null) {
  const findById = jest.fn().mockResolvedValue(sandbox);
  mockSandboxQuery.mockReturnValueOnce({ findById });
  return findById;
}

function sessionQueryResult(session: Record<string, unknown> | null) {
  const findById = jest.fn().mockResolvedValue(session);
  mockSessionQuery.mockReturnValueOnce({ findById });
  return findById;
}

describe('chatPreviewHostResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a known stale preview host to its active owner session without marking it ready', async () => {
    const exposureQuery = exposureQueryResult({
      id: 44,
      sandboxId: 9,
      status: 'ended',
      endedAt: '2026-06-29T12:00:00.000Z',
    });
    const findSandbox = sandboxQueryResult({
      id: 9,
      sessionId: 321,
      status: 'suspended',
    });
    const findSession = sessionQueryResult({
      id: 321,
      uuid: 'session-1',
      userId: 'user-123',
      status: 'active',
      workspaceStatus: 'hibernated',
    });

    await expect(resolveChatPreviewSessionForHost(hostMatch)).resolves.toEqual({
      sessionId: 'session-1',
      userId: 'user-123',
      ready: false,
    });

    expect(exposureQuery.where).toHaveBeenCalledWith({ kind: 'preview', targetPort: 3000 });
    expect(exposureQuery.whereRaw).toHaveBeenCalledWith('"metadata"->>? = ?', [
      'previewSlug',
      'abcdef1234567890abcdef1234567890',
    ]);
    expect(findSandbox).toHaveBeenCalledWith(9);
    expect(findSession).toHaveBeenCalledWith(321);
  });

  it('marks a host ready only when exposure, sandbox, and session are all ready', async () => {
    exposureQueryResult({
      id: 44,
      sandboxId: 9,
      status: 'ready',
      endedAt: null,
    });
    sandboxQueryResult({
      id: 9,
      sessionId: 321,
      status: 'ready',
    });
    sessionQueryResult({
      id: 321,
      uuid: 'session-1',
      userId: 'user-123',
      status: 'active',
      workspaceStatus: 'ready',
    });

    await expect(resolveChatPreviewSessionForHost(hostMatch)).resolves.toEqual({
      sessionId: 'session-1',
      userId: 'user-123',
      ready: true,
    });
  });

  it('does not resolve unknown hosts or ended sessions', async () => {
    exposureQueryResult(null);
    await expect(resolveChatPreviewSessionForHost(hostMatch)).resolves.toBeNull();

    exposureQueryResult({
      id: 44,
      sandboxId: 9,
      status: 'ready',
      endedAt: null,
    });
    sandboxQueryResult({
      id: 9,
      sessionId: 321,
      status: 'ready',
    });
    sessionQueryResult({
      id: 321,
      uuid: 'session-1',
      userId: 'user-123',
      status: 'ended',
      workspaceStatus: 'ended',
    });

    await expect(resolveChatPreviewSessionForHost(hostMatch)).resolves.toBeNull();
  });
});
