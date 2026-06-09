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

import {
  buildAgentRequestGitHubAuthFromToken,
  hasWriteAuthorizedUserGitHubAuth,
  markGitHubAuthWriteAuthorized,
} from '../githubAuth';

describe('githubAuth', () => {
  it('marks only user GitHub tokens as write authorized', () => {
    const userAuth = buildAgentRequestGitHubAuthFromToken('user-token', 'user', {
      githubUsername: 'octocat',
    });

    expect(hasWriteAuthorizedUserGitHubAuth(userAuth)).toBe(false);
    expect(markGitHubAuthWriteAuthorized(userAuth)).toEqual({
      githubToken: 'user-token',
      source: 'user',
      githubUsername: 'octocat',
      writeAuthorized: true,
    });
    expect(hasWriteAuthorizedUserGitHubAuth(markGitHubAuthWriteAuthorized(userAuth))).toBe(true);
    expect(markGitHubAuthWriteAuthorized(buildAgentRequestGitHubAuthFromToken('app-token', 'app'))).toEqual({
      githubToken: 'app-token',
      source: 'app',
      githubUsername: null,
      writeAuthorized: false,
    });
  });
});
