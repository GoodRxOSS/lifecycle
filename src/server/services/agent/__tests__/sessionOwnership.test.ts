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

const mockAgentSessionQuery = jest.fn();

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAgentSessionQuery(...args),
  },
}));

import { getOwnedSession } from '../sessionOwnership';

function buildQuery(result: unknown) {
  const query = {
    findOne: jest.fn().mockResolvedValue(result),
  };
  return query;
}

describe('getOwnedSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the session scoped to uuid + userId', async () => {
    const session = { id: 1, uuid: 'session-uuid', userId: 'user-1' };
    const query = buildQuery(session);
    mockAgentSessionQuery.mockReturnValue(query);

    const result = await getOwnedSession('session-uuid', 'user-1');

    expect(result).toBe(session);
    expect(query.findOne).toHaveBeenCalledWith({ uuid: 'session-uuid', userId: 'user-1' });
  });

  it('throws when no session matches the requesting user', async () => {
    mockAgentSessionQuery.mockReturnValue(buildQuery(undefined));

    await expect(getOwnedSession('missing', 'user-1')).rejects.toThrow('Agent session not found');
  });
});
