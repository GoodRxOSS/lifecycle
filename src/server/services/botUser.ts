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

import BaseService from './_service';

export default class BotUserService extends BaseService {
  /**
   * Returns boolean if the githubLogin user is listed as a bot
   * @param githubLogin Github username that created the PR
   * @returns {boolean}
   */
  async isBotUser(githubLogin: string): Promise<boolean> {
    const user = await this.db.models.BotUser.findOne({
      githubUser: githubLogin,
    });
    return Boolean(user);
  }
}
