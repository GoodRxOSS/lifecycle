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

jest.mock('server/models/AgentSource', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

import AgentSource from 'server/models/AgentSource';
import AgentSourceService from '../SourceService';

const mockSourceQuery = AgentSource.query as jest.Mock;

describe('AgentSourceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a source row for new session ownership', async () => {
    const insertAndFetch = jest.fn().mockResolvedValue({ id: 1 });
    mockSourceQuery.mockReturnValueOnce({ insertAndFetch });

    await AgentSourceService.createSessionSource({
      id: 3,
      buildUuid: 'build-1',
      buildKind: 'environment',
      sessionKind: 'environment',
      status: 'starting',
      workspaceStatus: 'provisioning',
      workspaceRepos: [{ repo: 'example-org/example-repo', mountPath: '/workspace/example-repo', primary: true }],
      selectedServices: [],
      updatedAt: '2026-04-24T12:00:00.000Z',
      endedAt: null,
    } as Parameters<typeof AgentSourceService.createSessionSource>[0]);

    expect(insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 3,
        adapter: 'lifecycle_environment',
        status: 'ready',
        input: {
          buildUuid: 'build-1',
          buildKind: 'environment',
          sessionKind: 'environment',
        },
        sandboxRequirements: expect.objectContaining({
          filesystem: 'persistent',
          suspendMode: 'none',
        }),
      })
    );
  });

  it('records source cleanup when sessions end', async () => {
    const existingSource = {
      id: 7,
      status: 'ready',
      cleanedUpAt: null,
      error: null,
    };
    const patchAndFetchById = jest.fn().mockResolvedValue({
      ...existingSource,
      status: 'cleaned_up',
      cleanedUpAt: '2026-04-24T12:00:00.000Z',
    });

    mockSourceQuery
      .mockReturnValueOnce({
        findOne: jest.fn().mockResolvedValue(existingSource),
      })
      .mockReturnValueOnce({
        patchAndFetchById,
      });

    await AgentSourceService.recordSessionState({
      id: 3,
      status: 'ended',
      workspaceStatus: 'ended',
      endedAt: '2026-04-24T12:00:00.000Z',
      updatedAt: '2026-04-24T12:00:00.000Z',
    } as Parameters<typeof AgentSourceService.recordSessionState>[0]);

    expect(patchAndFetchById).toHaveBeenCalledWith(7, {
      status: 'cleaned_up',
      cleanedUpAt: '2026-04-24T12:00:00.000Z',
    });
  });

  it('records source failure only for terminal session errors', async () => {
    const existingSource = {
      id: 8,
      status: 'ready',
      cleanedUpAt: null,
      error: null,
    };
    const patchAndFetchById = jest.fn().mockResolvedValue({
      ...existingSource,
      status: 'failed',
      error: { message: 'Source failed' },
    });

    mockSourceQuery
      .mockReturnValueOnce({
        findOne: jest.fn().mockResolvedValue(existingSource),
      })
      .mockReturnValueOnce({
        patchAndFetchById,
      });

    await AgentSourceService.recordSessionState({
      id: 4,
      status: 'error',
      workspaceStatus: 'failed',
      endedAt: null,
      updatedAt: '2026-04-24T12:00:00.000Z',
    } as Parameters<typeof AgentSourceService.recordSessionState>[0]);

    expect(patchAndFetchById).toHaveBeenCalledWith(8, {
      status: 'failed',
      error: { message: 'Source failed' },
    });
  });
});
