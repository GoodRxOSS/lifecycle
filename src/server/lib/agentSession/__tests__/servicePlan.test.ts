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

import { buildCombinedInstallCommand, resolveAgentSessionServicePlan } from '../servicePlan';
import { SESSION_WORKSPACE_REPOS_ROOT, SESSION_WORKSPACE_ROOT } from '../workspace';

describe('servicePlan', () => {
  it('keeps the primary repo at the workspace root for single-repo sessions', () => {
    const plan = resolveAgentSessionServicePlan(
      {
        repoUrl: 'https://github.com/example-org/api.git',
        branch: 'feature/api',
      },
      [
        {
          name: 'api',
          deployId: 1,
          repo: 'example-org/api',
          branch: 'feature/api',
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            installCommand: 'pnpm install',
          },
        },
      ]
    );

    expect(plan.workspaceRepos).toEqual([
      expect.objectContaining({
        repo: 'example-org/api',
        mountPath: SESSION_WORKSPACE_ROOT,
        primary: true,
      }),
    ]);
    expect(buildCombinedInstallCommand(plan.services)).toBe('pnpm install');
  });

  it('rewrites multi-repo service config against sibling mounted workspace paths', () => {
    const plan = resolveAgentSessionServicePlan({}, [
      {
        name: 'api',
        deployId: 1,
        repo: 'example-org/api',
        branch: 'feature/api',
        devConfig: {
          image: 'node:20',
          command: 'pnpm dev',
          installCommand: 'pnpm install',
        },
      },
      {
        name: 'web',
        deployId: 2,
        repo: 'example-org/web',
        branch: 'feature/web',
        devConfig: {
          image: 'node:20',
          workDir: '/workspace/apps/web',
          command: 'pnpm --dir /workspace/apps/web dev',
          installCommand: 'pnpm install',
          env: {
            CONFIG_PATH: '/workspace/config',
          },
        },
      },
    ]);

    expect(plan.workspaceRepos).toEqual([
      expect.objectContaining({
        repo: 'example-org/api',
        mountPath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/api`,
        primary: true,
      }),
      expect.objectContaining({
        repo: 'example-org/web',
        mountPath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web`,
        primary: false,
      }),
    ]);

    expect(plan.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'web',
          workspacePath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web`,
          workDir: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web/apps/web`,
          devConfig: expect.objectContaining({
            workDir: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web/apps/web`,
            command: `pnpm --dir ${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web/apps/web dev`,
            installCommand: 'pnpm install',
            env: {
              CONFIG_PATH: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web/config`,
            },
          }),
        }),
      ])
    );

    expect(plan.selectedServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'web',
          repo: 'example-org/web',
          branch: 'feature/web',
          workspacePath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web`,
          workDir: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web/apps/web`,
        }),
      ])
    );
  });

  it('builds repo-aware install commands for every repo in multi-repo sessions', () => {
    const plan = resolveAgentSessionServicePlan({}, [
      {
        name: 'api',
        deployId: 1,
        repo: 'example-org/api',
        branch: 'feature/api',
        devConfig: {
          image: 'node:20',
          command: 'pnpm dev',
          installCommand: 'pnpm install',
        },
      },
      {
        name: 'web',
        deployId: 2,
        repo: 'example-org/web',
        branch: 'feature/web',
        devConfig: {
          image: 'node:20',
          command: 'pnpm dev',
          installCommand: 'pnpm install',
        },
      },
    ]);

    expect(buildCombinedInstallCommand(plan.services)).toBe(
      `cd "${SESSION_WORKSPACE_REPOS_ROOT}/example-org/api"\npnpm install\n\ncd "${SESSION_WORKSPACE_REPOS_ROOT}/example-org/web"\npnpm install`
    );
  });

  it('rejects conflicting branches for the same repository', () => {
    expect(() =>
      resolveAgentSessionServicePlan({}, [
        {
          name: 'api',
          deployId: 1,
          repo: 'example-org/api',
          branch: 'feature/one',
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
          },
        },
        {
          name: 'worker',
          deployId: 2,
          repo: 'example-org/api',
          branch: 'feature/two',
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
          },
        },
      ])
    ).toThrow('Selected services require conflicting branches for example-org/api');
  });
});
