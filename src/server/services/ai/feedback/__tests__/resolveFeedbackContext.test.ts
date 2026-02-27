/**
 * Copyright 2025 GoodRx, Inc.
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

jest.mock('server/models/Build', () => {
  const model: { query: jest.Mock } = { query: jest.fn() };
  return { __esModule: true, default: model };
});

jest.mock('server/models/Conversation', () => {
  const model: { query: jest.Mock } = { query: jest.fn() };
  return { __esModule: true, default: model };
});

import Build from 'server/models/Build';
import Conversation from 'server/models/Conversation';
import { resolveFeedbackContext } from '../resolveFeedbackContext';

const MockBuild = Build as unknown as { query: jest.Mock };
const MockConversation = Conversation as unknown as { query: jest.Mock };

describe('resolveFeedbackContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers build pull request context when available', async () => {
    const findById = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue({ repo: 'conversation/repo' }) });
    MockConversation.query.mockReturnValue({ findById });

    const modifyGraph = jest.fn().mockResolvedValue({
      pullRequest: {
        fullName: 'build/repo',
        pullRequestNumber: 44,
      },
    });
    const withGraphFetched = jest.fn().mockReturnValue({ modifyGraph });
    const findOne = jest.fn().mockReturnValue({ withGraphFetched });
    MockBuild.query.mockReturnValue({ findOne });

    await expect(resolveFeedbackContext('uuid-1')).resolves.toEqual({
      repo: 'build/repo',
      prNumber: 44,
    });
  });

  it('returns conversation repo without prNumber when build pull request data is missing', async () => {
    const select = jest.fn().mockResolvedValue({ repo: 'conversation/repo' });
    const findById = jest.fn().mockReturnValue({ select });
    MockConversation.query.mockReturnValue({ findById });

    const modifyGraph = jest.fn().mockResolvedValue({ pullRequest: null });
    const withGraphFetched = jest.fn().mockReturnValue({ modifyGraph });
    const findOne = jest.fn().mockReturnValue({ withGraphFetched });
    MockBuild.query.mockReturnValue({ findOne });

    await expect(resolveFeedbackContext('uuid-2')).resolves.toEqual({
      repo: 'conversation/repo',
    });
  });
});
