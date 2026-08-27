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
  applyWorkspaceReposToServices,
  buildCombinedInstallCommand,
  resolveAgentSessionServicePlan,
  resolveAgentSessionWorkspaceRepos,
  rewriteDevConfigForWorkspaceRepo,
  workspaceRepoKey,
} from '../servicePlan';
import { SESSION_WORKSPACE_REPOS_ROOT, SESSION_WORKSPACE_ROOT } from '../workspace';

describe('servicePlan', () => {
  it('normalizes repository keys before using them for plan identity', () => {
    expect(workspaceRepoKey('  Example-Org/API  ')).toBe('example-org/api');
  });

  it('defaults a repo-specific dev config to the repository root without mutating the source config', () => {
    const devConfig = { image: 'node:20' };

    expect(rewriteDevConfigForWorkspaceRepo(devConfig, '/workspace/repos/example-org/api')).toEqual({
      image: 'node:20',
      workDir: '/workspace/repos/example-org/api',
    });
    expect(devConfig).toEqual({ image: 'node:20' });
  });

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

  it('uses explicit workspace repositories ahead of legacy fields and coalesces duplicate repo metadata', () => {
    const repos = resolveAgentSessionWorkspaceRepos(
      {
        repoUrl: 'https://github.com/ignored/legacy.git',
        branch: 'legacy',
        workspaceRepos: [
          {
            repo: 'Example-Org/API',
            repoUrl: '',
            branch: 'main',
            revision: null,
            mountPath: '/stale/input/path',
            primary: false,
          },
          {
            repo: 'example-org/api',
            repoUrl: 'https://github.com/Example-Org/API.git',
            branch: 'main',
            revision: null,
            mountPath: '/another/stale/input/path',
            primary: true,
          },
        ],
      },
      [
        { repo: 'example-org/api', branch: 'main', revision: 'commit-api' },
        { repo: null, branch: 'main', revision: null },
        { repo: 'example-org/worker', branch: 'worker', revision: null },
      ]
    );

    expect(repos).toEqual([
      expect.objectContaining({
        repo: 'Example-Org/API',
        repoUrl: 'https://github.com/Example-Org/API.git',
        branch: 'main',
        revision: 'commit-api',
        mountPath: `${SESSION_WORKSPACE_REPOS_ROOT}/Example-Org/API`,
        primary: true,
      }),
      expect.objectContaining({
        repo: 'example-org/worker',
        branch: 'worker',
        revision: null,
        mountPath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/worker`,
        primary: false,
      }),
    ]);
    expect(repos).not.toEqual(expect.arrayContaining([expect.objectContaining({ repo: 'ignored/legacy' })]));
  });

  it('rejects a legacy repository URL that has no repository name', () => {
    expect(() =>
      resolveAgentSessionWorkspaceRepos(
        {
          repoUrl: 'https://github.com/.git',
          branch: 'main',
        },
        undefined
      )
    ).toThrow('Unable to resolve repository name from repoUrl');
  });

  it('requires at least one complete repository source', () => {
    expect(() =>
      resolveAgentSessionWorkspaceRepos({}, [{ repo: 'example-org/api', branch: null, revision: null }])
    ).toThrow('At least one workspace repository is required');
  });

  it('rejects conflicting revisions for the same repository and branch', () => {
    expect(() =>
      resolveAgentSessionWorkspaceRepos({}, [
        { repo: 'example-org/api', branch: 'main', revision: 'commit-one' },
        { repo: 'EXAMPLE-ORG/API', branch: 'main', revision: 'commit-two' },
      ])
    ).toThrow('Selected services require conflicting revisions for EXAMPLE-ORG/API: commit-one and commit-two');
  });

  it('rejects multiple repositories marked as primary', () => {
    expect(() =>
      resolveAgentSessionWorkspaceRepos(
        {
          workspaceRepos: [
            {
              repo: 'example-org/api',
              repoUrl: 'https://github.com/example-org/api.git',
              branch: 'main',
              revision: null,
              mountPath: '/workspace/repos/example-org/api',
              primary: true,
            },
            {
              repo: 'example-org/web',
              repoUrl: 'https://github.com/example-org/web.git',
              branch: 'main',
              revision: null,
              mountPath: '/workspace/repos/example-org/web',
              primary: true,
            },
          ],
        },
        undefined
      )
    ).toThrow('Multiple primary repositories were requested: example-org/api and example-org/web');
  });

  it('preserves the distinction between absent and explicitly empty service selections', () => {
    const workspaceRepos = [
      {
        repo: 'example-org/api',
        repoUrl: 'https://github.com/example-org/api.git',
        branch: 'main',
        revision: null,
        mountPath: SESSION_WORKSPACE_ROOT,
        primary: true,
      },
    ];

    expect(applyWorkspaceReposToServices(undefined, workspaceRepos)).toEqual({
      services: undefined,
      selectedServices: [],
    });
    expect(applyWorkspaceReposToServices([], workspaceRepos)).toEqual({
      services: [],
      selectedServices: [],
    });
  });

  it('falls back to the first repository for legacy plans without an explicit primary marker', () => {
    const workspaceRepo = {
      repo: 'example-org/api',
      repoUrl: 'https://github.com/example-org/api.git',
      branch: 'main',
      revision: 'commit-api',
      mountPath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/api`,
      primary: false,
    };

    const result = applyWorkspaceReposToServices(
      [
        {
          name: 'api',
          deployId: 1,
          devConfig: { image: 'node:20', command: 'pnpm dev' },
        },
      ],
      [workspaceRepo]
    );

    expect(result.services).toEqual([
      expect.objectContaining({
        repo: 'example-org/api',
        branch: 'main',
        revision: 'commit-api',
        workspacePath: workspaceRepo.mountPath,
        workDir: workspaceRepo.mountPath,
      }),
    ]);
    expect(result.selectedServices).toEqual([
      expect.objectContaining({
        name: 'api',
        repo: 'example-org/api',
        branch: 'main',
        revision: 'commit-api',
        workspacePath: workspaceRepo.mountPath,
        workDir: workspaceRepo.mountPath,
      }),
    ]);
  });

  it('rejects a selected service whose repository is absent from the workspace plan', () => {
    expect(() =>
      applyWorkspaceReposToServices(
        [
          {
            name: 'worker',
            deployId: 2,
            repo: 'example-org/worker',
            branch: 'main',
            devConfig: { image: 'node:20' },
          },
        ],
        [
          {
            repo: 'example-org/api',
            repoUrl: 'https://github.com/example-org/api.git',
            branch: 'main',
            revision: null,
            mountPath: SESSION_WORKSPACE_ROOT,
            primary: true,
          },
        ]
      )
    ).toThrow('Workspace repository missing for selected service worker in example-org/worker');
  });

  it('omits services with incomplete install configuration', () => {
    expect(buildCombinedInstallCommand(undefined)).toBeUndefined();
    expect(
      buildCombinedInstallCommand([
        {
          workspacePath: SESSION_WORKSPACE_ROOT,
          devConfig: { image: 'node:20' },
        },
        {
          devConfig: { image: 'node:20', installCommand: 'pnpm install' },
        },
        {
          workspacePath: SESSION_WORKSPACE_ROOT,
          devConfig: { image: 'node:20', installCommand: '  ' },
        },
        {
          workspacePath: '  ',
          devConfig: { image: 'node:20', installCommand: 'pnpm install' },
        },
      ])
    ).toBeUndefined();
  });

  it.each([
    ['already targets a workspace path', 'pnpm --dir /workspace/apps/api install'],
    ['already changes directory', 'cd apps/api\npnpm install'],
  ])('does not prepend another directory when an install command %s', (_case, installCommand) => {
    expect(
      buildCombinedInstallCommand([
        {
          workspacePath: `${SESSION_WORKSPACE_REPOS_ROOT}/example-org/api`,
          devConfig: { image: 'node:20', installCommand },
        },
      ])
    ).toBe(installCommand);
  });
});
