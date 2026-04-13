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
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

import AgentRunService from '../RunService';
import AgentRun from 'server/models/AgentRun';

const mockRunQuery = AgentRun.query as jest.Mock;
const VALID_RUN_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('AgentRunService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getOwnedRun', () => {
    it('rejects invalid run UUIDs before querying the database', async () => {
      await expect(AgentRunService.getOwnedRun('unavailable', 'sample-user')).rejects.toThrow('Agent run not found');

      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('queries valid run UUIDs', async () => {
      const first = jest.fn().mockResolvedValue({
        id: 1,
        uuid: VALID_RUN_UUID,
      });
      const select = jest.fn();
      const query = {
        where: jest.fn(),
        select,
      };
      const joinRelated = jest.fn().mockReturnValue(query);
      const alias = jest.fn().mockReturnValue({ joinRelated });

      query.where.mockReturnValue(query);
      select.mockReturnValue({ first });

      mockRunQuery.mockReturnValue({ alias });

      await AgentRunService.getOwnedRun(VALID_RUN_UUID, 'sample-user');

      expect(mockRunQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRunByUuid', () => {
    it('returns undefined for invalid run UUIDs without querying the database', async () => {
      await expect(AgentRunService.getRunByUuid('unavailable')).resolves.toBeUndefined();

      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('queries a valid run UUID', async () => {
      const findOne = jest.fn().mockResolvedValue({
        id: 1,
        uuid: VALID_RUN_UUID,
      });

      mockRunQuery.mockReturnValue({ findOne });

      await expect(AgentRunService.getRunByUuid(VALID_RUN_UUID)).resolves.toEqual({
        id: 1,
        uuid: VALID_RUN_UUID,
      });

      expect(findOne).toHaveBeenCalledWith({ uuid: VALID_RUN_UUID });
    });
  });
});
