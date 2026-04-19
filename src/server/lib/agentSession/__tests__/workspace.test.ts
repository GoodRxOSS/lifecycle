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
  buildSessionWorkspaceEditorContents,
  buildSessionWorkspaceRepoMountPath,
  normalizeSessionWorkspaceRepo,
  SESSION_WORKSPACE_REPOS_ROOT,
  SESSION_WORKSPACE_ROOT,
} from '../workspace';

describe('workspace', () => {
  it('uses /workspace for the primary repo in single-repo sessions', () => {
    expect(buildSessionWorkspaceRepoMountPath('example-org/api', true)).toBe(SESSION_WORKSPACE_ROOT);
  });

  it('uses sibling repo mounts for the primary repo in multi-repo sessions', () => {
    expect(
      buildSessionWorkspaceRepoMountPath('example-org/api', true, {
        useWorkspaceRootForPrimary: false,
      })
    ).toBe(`${SESSION_WORKSPACE_REPOS_ROOT}/example-org/api`);
  });

  it('normalizes multi-repo primary paths consistently', () => {
    expect(
      normalizeSessionWorkspaceRepo(
        {
          repo: 'example-org/api',
          repoUrl: 'https://github.com/example-org/api.git',
          branch: 'feature/api',
          revision: null,
        },
        true,
        { useWorkspaceRootForPrimary: false }
      )
    ).toEqual({
      repo: 'example-org/api',
      repoUrl: 'https://github.com/example-org/api.git',
      branch: 'feature/api',
      revision: null,
      mountPath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/api`,
      primary: true,
    });
  });

  it('writes editor workspace folders for sibling repo mounts', () => {
    expect(
      buildSessionWorkspaceEditorContents([
        {
          repo: 'example-org/api',
          repoUrl: 'https://github.com/example-org/api.git',
          branch: 'feature/api',
          revision: null,
          mountPath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/api`,
          primary: true,
        },
        {
          repo: 'example-org/web',
          repoUrl: 'https://github.com/example-org/web.git',
          branch: 'feature/web',
          revision: null,
          mountPath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web`,
          primary: false,
        },
      ])
    ).toContain(`"path": "${SESSION_WORKSPACE_REPOS_ROOT}/example-org/api"`);
  });
});
