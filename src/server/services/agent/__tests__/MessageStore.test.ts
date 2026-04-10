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

jest.mock('server/models/AgentMessage', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentRun', () => ({
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

import AgentMessage from 'server/models/AgentMessage';
import AgentMessageStore from '../MessageStore';

const mockMessageQuery = AgentMessage.query as jest.Mock;

describe('AgentMessageStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listRunMessages', () => {
    it('filters through the joined run thread session alias', async () => {
      const orderBy = jest.fn().mockResolvedValue([]);
      const select = jest.fn().mockReturnValue({ orderBy });
      const secondWhere = jest.fn().mockReturnValue({ select });
      const firstWhere = jest.fn().mockReturnValue({ where: secondWhere });
      const joinRelated = jest.fn().mockReturnValue({ where: firstWhere });
      const alias = jest.fn().mockReturnValue({ joinRelated });
      mockMessageQuery.mockReturnValue({ alias });

      await AgentMessageStore.listRunMessages('2b3a4084-caf5-4eca-a4bb-6fdd7e93ae04', 'sample-user');

      expect(alias).toHaveBeenCalledWith('message');
      expect(joinRelated).toHaveBeenCalledWith('run.thread.session');
      expect(firstWhere).toHaveBeenCalledWith('run.uuid', '2b3a4084-caf5-4eca-a4bb-6fdd7e93ae04');
      expect(secondWhere).toHaveBeenCalledWith('run:thread:session.userId', 'sample-user');
    });
  });
});
