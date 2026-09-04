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

const mockWaitForJobAndGetLogs = jest.fn();
const mockGetGithubClientToken = jest.fn();

jest.mock('server/lib/kubernetes/JobMonitor', () => ({
  JobMonitor: {
    waitForJobAndGetLogs: (...args: unknown[]) => mockWaitForJobAndGetLogs(...args),
  },
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getGithubClientToken: mockGetGithubClientToken }),
  },
}));

import {
  createBuildJobManifest,
  createCloneScript,
  createGitCloneContainer,
  createJob,
  createRepoSpecificGitCloneContainer,
  DEFAULT_BUILD_RESOURCES,
  GIT_USERNAME,
  getBuildAnnotations,
  getBuildLabels,
  getGitHubToken,
  MANIFEST_PATH,
  waitForJobAndGetLogs,
} from '../utils';

describe('nativeBuild/utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes the shared builder defaults and workspace constants', () => {
    expect(DEFAULT_BUILD_RESOURCES).toMatchObject({
      buildkit: { requests: { cpu: '500m', memory: '1Gi' } },
      kaniko: { requests: { cpu: '300m', memory: '750Mi' } },
    });
    expect(GIT_USERNAME).toBe('x-access-token');
    expect(MANIFEST_PATH).toBe('/tmp/manifests');
  });

  it('forwards job monitoring inputs and returns the collected result', async () => {
    const result = { logs: 'build complete', success: true, status: 'Complete' };
    mockWaitForJobAndGetLogs.mockResolvedValue(result);

    await expect(waitForJobAndGetLogs('build-job', 'preview-1', 17)).resolves.toBe(result);
    expect(mockWaitForJobAndGetLogs).toHaveBeenCalledWith('build-job', 'preview-1', 17);
  });

  it('builds stable labels and timestamped annotations', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:34:56.000Z'));
    try {
      expect(getBuildLabels('api', 'build-uuid', '42', 'abcdef0', 'main', 'buildkit')).toEqual({
        'lc-service': 'api',
        'lc-uuid': 'build-uuid',
        'lc-build-id': '42',
        'git-sha': 'abcdef0',
        'git-branch': 'main',
        'builder-engine': 'buildkit',
        'build-method': 'native',
      });
      expect(getBuildAnnotations('Dockerfile.api', 'registry.example/api')).toEqual({
        'lfc/dockerfile': 'Dockerfile.api',
        'lfc/ecr-repo': 'registry.example/api',
        'lfc/triggered-at': '2026-08-27T12:34:56.000Z',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns the configured GitHub client token', async () => {
    mockGetGithubClientToken.mockResolvedValue('ghs_app_token');

    await expect(getGitHubToken()).resolves.toBe('ghs_app_token');
    expect(mockGetGithubClientToken).toHaveBeenCalledTimes(1);
  });

  it('builds shallow clone commands with an optional exact-SHA checkout', () => {
    const branchOnly = createCloneScript('GoodRxOSS/lifecycle', 'main');
    const exactSha = createCloneScript('GoodRxOSS/lifecycle', 'feature/test', 'abcdef123');

    expect(branchOnly).toContain('git clone --depth 1 --single-branch --progress -b main');
    expect(branchOnly).not.toContain('git fetch --depth 1 --progress origin');
    expect(exactSha).toContain('git fetch --depth 1 --progress origin abcdef123');
    expect(exactSha).toContain('git checkout abcdef123');
  });

  describe('createGitCloneContainer', () => {
    it('creates a proper git clone container configuration', () => {
      const container = createGitCloneContainer('owner/repo', 'abc123def456', 'x-access-token', 'github-token-123');

      expect(container.name).toBe('git-clone');
      expect(container.image).toBe('alpine/git:latest');
      expect(container.command).toEqual(['sh', '-c']);
      expect(container.args[0]).toContain('git fetch --depth 1 --progress origin abc123def456');
      expect(container.args[0]).toContain('owner/repo');
      expect(container.args[0]).toContain('git checkout FETCH_HEAD');

      expect(container.env).toEqual([
        { name: 'GIT_USERNAME', value: 'x-access-token' },
        { name: 'GIT_PASSWORD', value: 'github-token-123' },
      ]);

      expect(container.volumeMounts).toEqual([{ name: 'workspace', mountPath: '/workspace' }]);
    });

    it('targets a caller-selected repository directory', () => {
      const container = createRepoSpecificGitCloneContainer(
        'GoodRxOSS/lifecycle-ui',
        'feature/test',
        '/workspace/lifecycle-ui',
        'x-access-token',
        'github-token-123'
      );

      expect(container.args[0]).toContain('safe.directory /workspace/lifecycle-ui');
      expect(container.args[0]).toContain('git init /workspace/lifecycle-ui');
      expect(container.args[0]).toContain('GoodRxOSS/lifecycle-ui.git');
      expect(container.args[0]).toContain('git fetch --depth 1 --progress origin feature/test');
      expect(container.env).toEqual([
        { name: 'GIT_USERNAME', value: 'x-access-token' },
        { name: 'GIT_PASSWORD', value: 'github-token-123' },
      ]);
    });
  });

  describe('createBuildJobManifest', () => {
    it('creates a complete job manifest with all required fields', () => {
      const options = {
        jobName: 'test-service-buildkit-abc-1234567',
        namespace: 'env-test-123',
        serviceAccount: 'native-build-sa',
        serviceName: 'test-service',
        deployUuid: 'test-service-abc123',
        buildId: '123',
        shortSha: '1234567',
        branch: 'main',
        engine: 'buildkit' as const,
        dockerfilePath: 'Dockerfile',
        ecrRepo: '123456789.dkr.ecr.us-east-1.amazonaws.com/test-repo',
        jobTimeout: 1800,
        gitCloneContainer: { name: 'git-clone' },
        buildContainer: { name: 'buildkit' },
        volumes: [{ name: 'workspace', emptyDir: {} }],
      };

      const manifest = createBuildJobManifest(options);

      // Check metadata
      expect(manifest.metadata.name).toBe('test-service-buildkit-abc-1234567');
      expect(manifest.metadata.namespace).toBe('env-test-123');

      // Check labels
      expect(manifest.metadata.labels['lc-service']).toBe('test-service');
      expect(manifest.metadata.labels['lc-deploy-uuid']).toBe('test-service-abc123');
      expect(manifest.metadata.labels['lc-build-id']).toBe('123');
      expect(manifest.metadata.labels['git-sha']).toBe('1234567');
      expect(manifest.metadata.labels['git-branch']).toBe('main');
      expect(manifest.metadata.labels['builder-engine']).toBe('buildkit');
      expect(manifest.metadata.labels['build-method']).toBe('native');

      // Check annotations
      expect(manifest.metadata.annotations['lfc/dockerfile']).toBe('Dockerfile');
      expect(manifest.metadata.annotations['lfc/ecr-repo']).toBe('123456789.dkr.ecr.us-east-1.amazonaws.com/test-repo');
      expect(manifest.metadata.annotations['lfc/triggered-at']).toBeDefined();

      // Check spec
      expect(manifest.spec.ttlSecondsAfterFinished).toBeUndefined(); // No TTL by default for non-static builds
      expect(manifest.spec.backoffLimit).toBe(0);
      expect(manifest.spec.activeDeadlineSeconds).toBe(1800);

      // Check template
      expect(manifest.spec.template.spec.serviceAccountName).toBe('native-build-sa');
      expect(manifest.spec.template.spec.restartPolicy).toBe('Never');
      expect(manifest.spec.template.spec.initContainers).toEqual([{ name: 'git-clone' }]);
      expect(manifest.spec.template.spec.containers).toEqual([{ name: 'buildkit' }]);
      expect(manifest.spec.template.spec.volumes).toEqual([{ name: 'workspace', emptyDir: {} }]);
    });

    it('sets TTL for static builds', () => {
      const options = {
        jobName: 'test-job',
        namespace: 'test-ns',
        serviceAccount: 'test-sa',
        serviceName: 'test-service',
        deployUuid: 'test-uuid',
        buildId: '123',
        shortSha: 'abc123',
        branch: 'main',
        engine: 'kaniko' as const,
        dockerfilePath: 'Dockerfile',
        ecrRepo: 'test-repo',
        jobTimeout: 1800,
        isStatic: true,
        gitCloneContainer: {},
        buildContainer: {},
        volumes: [],
      };

      const manifest = createBuildJobManifest(options);
      expect(manifest.spec.ttlSecondsAfterFinished).toBe(86400); // 24 hours for static builds
    });

    it('uses an empty init list and workspace volume when optional inputs are absent at runtime', () => {
      const manifest = createBuildJobManifest({
        jobName: 'test-job',
        namespace: 'test-ns',
        serviceAccount: 'test-sa',
        serviceName: 'test-service',
        deployUuid: 'test-uuid',
        buildId: '123',
        shortSha: 'abc123',
        branch: 'main',
        engine: 'kaniko',
        dockerfilePath: 'Dockerfile',
        ecrRepo: 'test-repo',
        jobTimeout: 1800,
        gitCloneContainer: null,
        buildContainer: { name: 'kaniko' },
        volumes: undefined,
      } as any);

      expect(manifest.spec.template.spec.initContainers).toBeUndefined();
      expect(manifest.spec.template.spec.volumes).toEqual([{ name: 'workspace', emptyDir: {} }]);
    });
  });

  describe('createJob', () => {
    it('coerces numeric env var values to strings', () => {
      const job = createJob(
        'test-job',
        'test-ns',
        'test-sa',
        'alpine:latest',
        ['sh', '-c'],
        ['echo hello'],
        { APP_NAME: 'my-app', APP_PORT: 8080, WORKERS: 4 } as any,
        { app: 'test' },
        { note: 'test' }
      );

      const envVars = job.spec!.template.spec!.containers![0].env!;
      for (const envVar of envVars) {
        expect(typeof envVar.value).toBe('string');
      }
      expect(envVars).toContainEqual({ name: 'APP_PORT', value: '8080' });
      expect(envVars).toContainEqual({ name: 'WORKERS', value: '4' });
      expect(envVars).toContainEqual({ name: 'APP_NAME', value: 'my-app' });
    });
  });
});
