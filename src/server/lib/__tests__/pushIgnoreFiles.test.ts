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
  getEffectiveIgnoreFiles,
  getServicePushIgnorePolicy,
  hasLifecycleConfigChange,
  normalizeGithubPath,
  normalizeIgnoreFiles,
  normalizeIncludeFiles,
  shouldSkipPushDeploy,
} from '../pushIgnoreFiles';

describe('pushIgnoreFiles', () => {
  test('normalizes GitHub paths from repository-relative Windows and absolute forms', () => {
    expect(normalizeGithubPath('.\\docs\\readme.md')).toBe('docs/readme.md');
    expect(normalizeGithubPath('/src/index.ts')).toBe('src/index.ts');
  });

  test('merges environment and service ignoreFiles uniquely', () => {
    expect(getEffectiveIgnoreFiles(['docs/**', '**/*.spec.ts'], ['docs/**', '**/*.stories.tsx'])).toEqual([
      'docs/**',
      '**/*.spec.ts',
      '**/*.stories.tsx',
    ]);
  });

  test('rejects invalid ignore patterns', () => {
    expect(() => normalizeIgnoreFiles({ pattern: 'docs/**' })).toThrow('must be an array of strings');
    expect(() => normalizeIgnoreFiles([''])).toThrow('cannot be empty');
    expect(() => normalizeIgnoreFiles(['/tmp/**'])).toThrow('repo-relative');
    expect(() => normalizeIgnoreFiles(['../secrets/**'])).toThrow('traverse');
    expect(() => normalizeIgnoreFiles(['docs/..'])).toThrow('traverse');
    expect(() => normalizeIgnoreFiles([123])).toThrow('must be strings');
    expect(() => normalizeIgnoreFiles(Array.from({ length: 51 }, (_value, index) => `docs/${index}.md`))).toThrow(
      'too many patterns'
    );
    expect(() => normalizeIgnoreFiles(['a'.repeat(201)])).toThrow('exceeds maximum length');
  });

  test('builds service policy from config inheritance', () => {
    const policy = getServicePushIgnorePolicy(
      {
        version: '1.0.0',
        environment: { ignoreFiles: ['docs/**'] },
        services: [
          {
            name: 'api',
            ignoreFiles: ['**/*.spec.ts'],
          },
        ],
      } as any,
      'api'
    );

    expect(policy).toEqual({
      serviceName: 'api',
      ignoreFiles: ['docs/**', '**/*.spec.ts'],
    });
  });

  test('builds service-only policy and returns null when no policy exists', () => {
    const config = {
      version: '1.0.0',
      environment: {},
      services: [
        {
          name: 'api',
          ignoreFiles: ['docs/**'],
        },
        {
          name: 'worker',
        },
      ],
    } as any;

    expect(getServicePushIgnorePolicy(config, 'api')).toEqual({
      serviceName: 'api',
      ignoreFiles: ['docs/**'],
    });
    expect(getServicePushIgnorePolicy(config, 'worker')).toBeNull();
    expect(getServicePushIgnorePolicy(config, 'missing')).toBeNull();
  });

  test('matches paths case-sensitively with broad glob support', () => {
    expect(
      shouldSkipPushDeploy({
        changedFiles: ['src/api.spec.ts', '.github/workflows/test.yml'],
        servicePolicies: [{ serviceName: 'api', ignoreFiles: ['**/*'] }],
      })
    ).toEqual({ shouldSkip: true, reason: 'all_changed_files_ignored' });

    expect(
      shouldSkipPushDeploy({
        changedFiles: ['src/API.spec.ts'],
        servicePolicies: [{ serviceName: 'api', ignoreFiles: ['src/api.spec.ts'] }],
      })
    ).toEqual({
      shouldSkip: false,
      reason: 'file_not_ignored',
      serviceName: 'api',
      filePath: 'src/API.spec.ts',
    });
  });

  test('requires every changed file to match every affected service policy', () => {
    expect(
      shouldSkipPushDeploy({
        changedFiles: ['docs/readme.md', 'src/api.ts'],
        servicePolicies: [{ serviceName: 'api', ignoreFiles: ['docs/**'] }],
      })
    ).toEqual({
      shouldSkip: false,
      reason: 'file_not_ignored',
      serviceName: 'api',
      filePath: 'src/api.ts',
    });
  });

  test('fails open when changed files or service policies are missing', () => {
    expect(shouldSkipPushDeploy({ changedFiles: [], servicePolicies: [] })).toEqual({
      shouldSkip: false,
      reason: 'no_changed_files',
    });
    expect(
      shouldSkipPushDeploy({
        changedFiles: ['docs/readme.md'],
        servicePolicies: [],
      })
    ).toEqual({
      shouldSkip: false,
      reason: 'no_service_policies',
    });
  });

  test('lists the services whose own policy ignores every changed file when others still deploy', () => {
    expect(
      shouldSkipPushDeploy({
        changedFiles: ['apps/next-web/src/page.tsx'],
        servicePolicies: [
          { serviceName: 'next-web', ignoreFiles: ['docs/**'] },
          { serviceName: 'psp-web', ignoreFiles: ['apps/next-web/**'] },
          { serviceName: 'rxsaver-web', ignoreFiles: ['apps/next-web/**'] },
        ],
      })
    ).toEqual({
      shouldSkip: false,
      reason: 'file_not_ignored',
      serviceName: 'next-web',
      filePath: 'apps/next-web/src/page.tsx',
      skipServices: ['psp-web', 'rxsaver-web'],
    });
  });

  test('keeps a service without a policy deploying while skipping services that ignore the change', () => {
    expect(
      shouldSkipPushDeploy({
        changedFiles: ['apps/next-web/src/page.tsx'],
        servicePolicies: [
          { serviceName: 'worker', ignoreFiles: [] },
          { serviceName: 'psp-web', ignoreFiles: ['apps/next-web/**'] },
        ],
      })
    ).toEqual({
      shouldSkip: false,
      reason: 'missing_service_policy',
      serviceName: 'worker',
      skipServices: ['psp-web'],
    });
  });

  test('treats files outside includeFiles as ignored, with ignoreFiles still applied inside them', () => {
    const psp = {
      serviceName: 'psp-web',
      ignoreFiles: ['**/*.spec.ts'],
      includeFiles: ['apps/psp/**', 'packages/shared/**', 'pnpm-lock.yaml'],
    };

    expect(
      shouldSkipPushDeploy({
        changedFiles: ['packages/accounts/src/a.ts', 'packages/shared/src/a.spec.ts'],
        servicePolicies: [psp],
      })
    ).toEqual({ shouldSkip: true, reason: 'all_changed_files_ignored' });
    expect(shouldSkipPushDeploy({ changedFiles: ['pnpm-lock.yaml'], servicePolicies: [psp] })).toEqual({
      shouldSkip: false,
      reason: 'file_not_ignored',
      serviceName: 'psp-web',
      filePath: 'pnpm-lock.yaml',
    });
  });

  test('builds an includeFiles-only service policy', () => {
    const config = {
      version: '1.0.0',
      environment: {},
      services: [{ name: 'psp-web', includeFiles: ['apps/psp/**'] }],
    } as any;

    expect(getServicePushIgnorePolicy(config, 'psp-web')).toEqual({
      serviceName: 'psp-web',
      ignoreFiles: [],
      includeFiles: ['apps/psp/**'],
    });
  });

  test('validates includeFiles with a larger pattern cap', () => {
    expect(normalizeIncludeFiles(Array.from({ length: 200 }, (_value, index) => `packages/${index}/**`))).toHaveLength(
      200
    );
    expect(() => normalizeIncludeFiles(Array.from({ length: 201 }, (_value, index) => `p/${index}/**`))).toThrow(
      'includeFiles has too many patterns'
    );
    expect(() => normalizeIncludeFiles(['../outside/**'])).toThrow('includeFiles patterns cannot traverse');
  });

  test('detects lifecycle config changes by new path', () => {
    expect(hasLifecycleConfigChange(['docs/readme.md', 'lifecycle.yaml'])).toBe(true);
    expect(hasLifecycleConfigChange(['docs/lifecycle.yml'])).toBe(false);
  });

  test('never skips a push that changes Lifecycle configuration', () => {
    expect(
      shouldSkipPushDeploy({
        changedFiles: ['./lifecycle.yml'],
        servicePolicies: [
          { serviceName: 'api', ignoreFiles: ['**/*'] },
          { serviceName: 'web', ignoreFiles: [], includeFiles: ['apps/web/**'] },
        ],
      })
    ).toEqual({
      shouldSkip: false,
      reason: 'lifecycle_config_changed',
    });
  });
});
