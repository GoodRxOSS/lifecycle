/**
 * Copyright 2026 Lifecycle contributors
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

import BotUserService from '../botUser';

describe('BotUserService', () => {
  it.each([
    ['recognizes a configured bot', { id: 1 }, true],
    ['treats an unknown login as a human', undefined, false],
  ])('%s', async (_name, record, expected) => {
    const findOne = jest.fn().mockResolvedValue(record);
    const service = new BotUserService({ models: { BotUser: { findOne } } } as any);

    await expect(service.isBotUser('release-bot')).resolves.toBe(expected);
    expect(findOne).toHaveBeenCalledWith({ githubUser: 'release-bot' });
  });
});
