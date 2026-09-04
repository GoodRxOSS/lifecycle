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

import { buildkitBuild, buildWithEngine, NativeBuildOptions, generateSecretArgsScript } from '../engines';
import { shellPromise } from '../../shell';
import { getLogger } from '../../logger';
import { waitForJobAndGetLogs, getGitHubToken } from '../utils';
import GlobalConfigService from '../../../services/globalConfig';
import { getLogArchivalService } from '../../../services/logArchival';
import { createNativeBuildRegistryAuthSecret, deleteNativeBuildRegistryAuthSecret } from '../registryAuth';

const mockArchiveLogs = jest.fn();

// Mock dependencies
jest.mock('../../shell');
jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    waitForJobAndGetLogs: jest.fn(),
    getGitHubToken: jest.fn(),
    createBuildJobManifest: actual.createBuildJobManifest,
    createGitCloneContainer: actual.createGitCloneContainer,
    createRepoSpecificGitCloneContainer: actual.createRepoSpecificGitCloneContainer,
    getBuildLabels: actual.getBuildLabels,
    getBuildAnnotations: actual.getBuildAnnotations,
    DEFAULT_BUILD_RESOURCES: actual.DEFAULT_BUILD_RESOURCES,
  };
});
jest.mock('../../../services/globalConfig');
jest.mock('../../../services/logArchival', () => ({
  getLogArchivalService: jest.fn(),
}));
jest.mock('../registryAuth', () => {
  const actual = jest.requireActual('../registryAuth');
  return {
    ...actual,
    createNativeBuildRegistryAuthSecret: jest.fn(),
    deleteNativeBuildRegistryAuthSecret: jest.fn(),
  };
});
jest.mock('../../../models', () => ({
  Build: {
    query: jest.fn().mockReturnValue({
      findById: jest.fn().mockResolvedValue({ isStatic: false }),
    }),
  },
  Deploy: {},
}));
jest.mock('../../logger', () => {
  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
    })),
  };
  return {
    getLogger: jest.fn(() => mockLogger),
  };
});

beforeEach(() => {
  mockArchiveLogs.mockReset().mockResolvedValue(undefined);
  (getLogArchivalService as jest.Mock).mockReset().mockReturnValue({ archiveLogs: mockArchiveLogs });
});

describe('buildkitBuild', () => {
  const mockDeploy = {
    deployable: { name: 'test-service' },
    $fetchGraph: jest.fn(),
    build: { isStatic: false },
  } as any;

  const mockOptions: NativeBuildOptions = {
    ecrRepo: 'test-repo',
    ecrDomain: '123456789.dkr.ecr.us-east-1.amazonaws.com',
    envVars: { NODE_ENV: 'production' },
    dockerfilePath: 'Dockerfile',
    tag: 'v1.0.0',
    revision: 'abc123def456789',
    repo: 'owner/repo',
    branch: 'main',
    namespace: 'env-test-123',
    buildId: '456',
    buildUuid: 'abc123',
    deployUuid: 'test-service-abc123',
    jobTimeout: 1800,
  };

  const mockGlobalConfig = {
    buildDefaults: {
      serviceAccount: 'native-build-sa',
      jobTimeout: 2100,
      resources: {
        buildkit: {
          requests: { cpu: '1', memory: '2Gi' },
          limits: { cpu: '2', memory: '4Gi' },
        },
      },
      buildkit: {
        endpoint: 'tcp://buildkit-custom.svc.cluster.local:1234',
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mocks
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(mockGlobalConfig),
    });

    (getGitHubToken as jest.Mock).mockResolvedValue('github-token-123');
    (createNativeBuildRegistryAuthSecret as jest.Mock).mockResolvedValue(undefined);
    (deleteNativeBuildRegistryAuthSecret as jest.Mock).mockResolvedValue(undefined);

    (shellPromise as jest.Mock).mockResolvedValue('');

    (waitForJobAndGetLogs as jest.Mock).mockResolvedValue({
      logs: 'Build completed successfully',
      success: true,
    });
  });

  it('creates and executes a buildkit job successfully', async () => {
    const result = await buildkitBuild(mockDeploy, mockOptions);

    expect(result.success).toBe(true);
    expect(result.logs).toBe('Build completed successfully');
    expect(result.jobName).toMatch(/^test-service-abc123-build-[a-z0-9]{5}-abc123d$/);

    // Verify kubectl apply was called
    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    expect(applyCall).toBeDefined();
    expect(applyCall[0]).toContain("cat <<'EOF' | kubectl apply -f -");
  });

  it('uses custom buildkit configuration from global config', async () => {
    const configWithCache = {
      ...mockGlobalConfig,
      buildDefaults: {
        ...mockGlobalConfig.buildDefaults,
        cacheRegistry: 'lifecycle-distribution.lifecycle-app.svc.cluster.local',
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(configWithCache),
    });

    await buildkitBuild(mockDeploy, mockOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    expect(applyCall).toBeDefined();

    const fullCommand = applyCall[0];

    // Check custom endpoint is used
    expect(fullCommand).toContain('value: "tcp://buildkit-custom.svc.cluster.local:1234"');

    // Check cache uses local distribution registry with service name and buildUuid for isolation
    expect(fullCommand).toContain(
      'ref=lifecycle-distribution.lifecycle-app.svc.cluster.local/test-repo/test-service/abc123:cache'
    );

    // Check custom resources are applied
    expect(fullCommand).toContain('cpu: "1"');
    expect(fullCommand).toContain('memory: "2Gi"');
  });

  it('falls back to service-name-only cache ref when buildUuid is not provided', async () => {
    const configWithCache = {
      ...mockGlobalConfig,
      buildDefaults: {
        ...mockGlobalConfig.buildDefaults,
        cacheRegistry: 'lifecycle-distribution.lifecycle-app.svc.cluster.local',
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(configWithCache),
    });

    const optionsWithoutBuildUuid = { ...mockOptions, buildUuid: undefined };
    await buildkitBuild(mockDeploy, optionsWithoutBuildUuid);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain(
      'ref=lifecycle-distribution.lifecycle-app.svc.cluster.local/test-repo/test-service:cache'
    );
    expect(fullCommand).not.toContain('test-service/abc123:cache');
  });

  it('handles init dockerfile build', async () => {
    const optionsWithInit = {
      ...mockOptions,
      initDockerfilePath: 'Dockerfile.init',
      initTag: 'v1.0.0-init',
    };

    await buildkitBuild(mockDeploy, optionsWithInit);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    // Should have init build with proper filename
    expect(fullCommand).toContain('filename=Dockerfile.init');
    expect(fullCommand).toContain('name=123456789.dkr.ecr.us-east-1.amazonaws.com/test-repo:v1.0.0-init');
  });

  it('returns failure result when job fails', async () => {
    (waitForJobAndGetLogs as jest.Mock).mockRejectedValue(new Error('Build failed'));

    const result = await buildkitBuild(mockDeploy, mockOptions);

    expect(result.success).toBe(false);
    expect(result.logs).toContain('Build failed');
    expect(result.jobName).toBeDefined();
  });

  it('checks job status even if log retrieval fails', async () => {
    (waitForJobAndGetLogs as jest.Mock).mockRejectedValue(new Error('Log retrieval timeout'));
    (shellPromise as jest.Mock)
      .mockResolvedValueOnce('') // kubectl apply
      .mockResolvedValueOnce('True'); // job status check

    const result = await buildkitBuild(mockDeploy, mockOptions);

    expect(result.success).toBe(true);
    expect(result.logs).toBe('Log retrieval failed but job completed successfully');

    // Verify job status was checked
    const statusCheckCall = (shellPromise as jest.Mock).mock.calls.find(
      (call) => call[0].includes('get job') && call[0].includes('.status.conditions')
    );
    expect(statusCheckCall).toBeDefined();
  });

  it('includes build args in buildctl command', async () => {
    await buildkitBuild(mockDeploy, mockOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    // Check build args are included
    expect(fullCommand).toContain('build-arg:NODE_ENV=production');
  });

  it('keeps registry bootstrap installs default and adds AWS retry env vars', async () => {
    await buildkitBuild(mockDeploy, mockOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('apk add --no-cache aws-cli docker-cli');
    expect(fullCommand).toContain('apk add --no-cache docker-cli');
    expect(fullCommand).toContain('export AWS_MAX_ATTEMPTS=5');
    expect(fullCommand).toContain('export AWS_RETRY_MODE=adaptive');
  });

  it('preserves the existing ECR output login flow', async () => {
    await buildkitBuild(mockDeploy, mockOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('REGISTRY_DOMAIN=\\"123456789.dkr.ecr.us-east-1.amazonaws.com\\"');
    expect(fullCommand).toContain('Detected AWS ECR registry');
    expect(fullCommand).toContain('AWS_REGION=$(echo \\"${REGISTRY_DOMAIN}\\" | sed');
    expect(fullCommand).toContain('aws sts get-caller-identity');
    expect(fullCommand).toContain('aws ecr get-login-password --region ${AWS_REGION}');
    expect(fullCommand).toContain(
      'echo \\"$ECR_PASSWORD\\" | docker login --username AWS --password-stdin ${REGISTRY_DOMAIN}'
    );
    expect(fullCommand).toContain('export DOCKER_CONFIG=~/.docker');
    expect(fullCommand).toContain(
      'type=image,name=123456789.dkr.ecr.us-east-1.amazonaws.com/test-repo:v1.0.0,push=true'
    );
  });

  it('renders registry domain safely for non-ECR buildkit targets', async () => {
    const optionsWithCustomRegistry = {
      ...mockOptions,
      ecrDomain: 'registry.internal.svc.cluster.local',
    };

    await buildkitBuild(mockDeploy, optionsWithCustomRegistry);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('REGISTRY_DOMAIN=\\"registry.internal.svc.cluster.local\\"');
    expect(fullCommand).toContain('apk add --no-cache docker-cli');
  });

  it('coerces numeric env var values to strings for Kubernetes compatibility', async () => {
    const optionsWithNumericEnv = {
      ...mockOptions,
      envVars: { APP_PORT: 3000, REPLICAS: 2, APP_NAME: 'my-app' } as any,
    };

    await buildkitBuild(mockDeploy, optionsWithNumericEnv);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('value: "3000"');
    expect(fullCommand).toContain('value: "2"');
    expect(fullCommand).toContain('value: "my-app"');
    expect(fullCommand).not.toMatch(/value: [0-9]/);
  });

  it('uses correct job naming pattern', async () => {
    const result = await buildkitBuild(mockDeploy, mockOptions);

    // Job name should follow pattern: {deployUuid}-build-{jobId}-{shortSha}
    expect(result.jobName).toMatch(/^test-service-abc123-build-[a-z0-9]{5}-abc123d$/);
    expect(result.jobName.length).toBeLessThanOrEqual(63); // Kubernetes name limit
  });

  it('canonicalizes long job names without leaving a trailing dash', async () => {
    const longNameOptions = {
      ...mockOptions,
      deployUuid: 'subs-process-cancellations-solitary-glitter-950234',
      revision: '0d84142392d618abb9d2b900bea68152bd80754d',
    };

    const result = await buildkitBuild(mockDeploy, longNameOptions);

    expect(result.jobName).toMatch(/^subs-process-cancellations-solitary-glitter-build-[a-z0-9]{5}-0d84142$/);
    expect(result.jobName.endsWith('-')).toBe(false);
    expect(result.jobName.length).toBeLessThanOrEqual(63);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    expect(applyCall[0]).toContain(`name: "${result.jobName}"`);
  });

  it('sets proper job metadata and labels', async () => {
    await buildkitBuild(mockDeploy, mockOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    // Check labels
    expect(fullCommand).toContain('lc-service: "test-service"');
    expect(fullCommand).toContain('lc-deploy-uuid: "test-service-abc123"');
    expect(fullCommand).toContain('lc-build-id: "456"');
    expect(fullCommand).toContain('git-sha: "abc123d"');
    expect(fullCommand).toContain('git-branch: "main"');
    expect(fullCommand).toContain('builder-engine: "buildkit"');
    expect(fullCommand).toContain('build-method: "native"');

    // Check annotations
    expect(fullCommand).toContain('lfc/dockerfile: "Dockerfile"');
    expect(fullCommand).toContain('lfc/ecr-repo: "test-repo"');
  });

  it('generates a static build job from boundary inputs through the public orchestrator', async () => {
    const staticDeploy = {
      deployable: { name: 'test-service' },
      $fetchGraph: jest.fn(),
      build: { isStatic: true },
    } as any;

    const result = await buildWithEngine(
      staticDeploy,
      {
        ...mockOptions,
        dockerfilePath: '',
        repo: 'repo-only',
        secretRefs: ['runtime-secrets', 'shared-secrets'],
      },
      'buildkit'
    );

    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(result.success).toBe(true);
    expect(staticDeploy.$fetchGraph).toHaveBeenCalledWith('build');
    expect(fullCommand).toContain('git init /workspace/repo-repo-only');
    expect(fullCommand).toContain('filename=Dockerfile');
    expect(fullCommand).toContain('lfc/dockerfile: "Dockerfile"');
    expect(fullCommand).toContain('ttlSecondsAfterFinished: 86400');
    expect(fullCommand).toContain('name: "runtime-secrets"');
    expect(fullCommand).toContain('name: "shared-secrets"');
    expect(fullCommand.match(/optional: false/g)).toHaveLength(2);
  });

  it('omits static-build retention when the fetched build relation is absent', async () => {
    const deployWithoutBuild = {
      deployable: { name: 'test-service' },
      $fetchGraph: jest.fn(),
    } as any;

    await buildWithEngine(deployWithoutBuild, mockOptions, 'buildkit');

    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    expect(deployWithoutBuild.$fetchGraph).toHaveBeenCalledWith('build');
    expect(applyCall[0]).not.toContain('ttlSecondsAfterFinished');
  });

  it.each([
    {
      source: 'global configuration',
      globalConfig: { buildDefaults: { jobTimeout: 975 } },
      expectedTimeout: 975,
    },
    {
      source: 'the built-in default',
      globalConfig: {},
      expectedTimeout: 2100,
    },
  ])('uses the job timeout from $source when an option is absent', async ({ globalConfig, expectedTimeout }) => {
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(globalConfig),
    });

    await buildkitBuild(mockDeploy, { ...mockOptions, jobTimeout: undefined });

    expect(waitForJobAndGetLogs).toHaveBeenCalledWith(
      expect.stringMatching(/^test-service-abc123-build-/),
      'env-test-123',
      expectedTimeout
    );
  });

  it.each([
    {
      source: 'the environment',
      environmentEndpoint: 'tcp://buildkit-from-environment.example:1234',
      expectedEndpoint: 'tcp://buildkit-from-environment.example:1234',
    },
    {
      source: 'the built-in default',
      environmentEndpoint: undefined,
      expectedEndpoint: 'tcp://lifecycle-buildkit.lifecycle-app.svc.cluster.local:1234',
    },
  ])(
    'uses the BuildKit endpoint from $source when database configuration is absent',
    async ({ environmentEndpoint, expectedEndpoint }) => {
      const previousEndpoint = process.env.BUILDKIT_HOST;
      if (environmentEndpoint === undefined) {
        delete process.env.BUILDKIT_HOST;
      } else {
        process.env.BUILDKIT_HOST = environmentEndpoint;
      }
      (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
        getAllConfigs: jest.fn().mockResolvedValue({}),
      });

      try {
        await buildkitBuild(mockDeploy, mockOptions);
      } finally {
        if (previousEndpoint === undefined) {
          delete process.env.BUILDKIT_HOST;
        } else {
          process.env.BUILDKIT_HOST = previousEndpoint;
        }
      }

      const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
      expect(applyCall[0]).toContain(`value: "${expectedEndpoint}"`);
    }
  );

  it('uses the default AWS region when the process environment does not provide one', async () => {
    const previousRegion = process.env.AWS_REGION;
    delete process.env.AWS_REGION;

    try {
      await buildkitBuild(mockDeploy, mockOptions);
    } finally {
      if (previousRegion === undefined) {
        delete process.env.AWS_REGION;
      } else {
        process.env.AWS_REGION = previousRegion;
      }
    }

    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    expect(applyCall[0].match(/name: "AWS_REGION"\n\s+value: "us-west-2"/g)).toHaveLength(1);
  });

  it.each([
    { success: true, expectedStatus: 'Complete' },
    { success: false, expectedStatus: 'Failed' },
  ])('archives completed job logs with status $expectedStatus', async ({ success, expectedStatus }) => {
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        ...mockGlobalConfig,
        logArchival: { enabled: true },
      }),
    });
    (waitForJobAndGetLogs as jest.Mock).mockResolvedValue({
      logs: 'captured build output',
      success,
      startedAt: '2026-08-27T08:00:00.000Z',
      completedAt: '2026-08-27T08:01:30.000Z',
      duration: 90,
    });

    const result = await buildkitBuild(mockDeploy, mockOptions);

    expect(result).toEqual({
      success,
      logs: 'captured build output',
      jobName: expect.stringMatching(/^test-service-abc123-build-/),
    });
    expect(getLogArchivalService).toHaveBeenCalledTimes(1);
    expect(mockArchiveLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: result.jobName,
        jobType: 'build',
        serviceName: 'test-service',
        namespace: 'env-test-123',
        status: expectedStatus,
        sha: 'abc123def456789',
        deployUuid: 'test-service-abc123',
        buildUuid: '456',
        engine: 'buildkit',
        startedAt: '2026-08-27T08:00:00.000Z',
        completedAt: '2026-08-27T08:01:30.000Z',
        duration: 90,
        archivedAt: expect.any(String),
      }),
      'captured build output'
    );
  });

  it('returns the successful build result when log archival fails', async () => {
    const archivalError = new Error('archive store unavailable');
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        ...mockGlobalConfig,
        logArchival: { enabled: true },
      }),
    });
    mockArchiveLogs.mockRejectedValue(archivalError);

    const result = await buildkitBuild(mockDeploy, mockOptions);

    expect(result.success).toBe(true);
    const logger = (getLogger as jest.Mock)();
    expect(logger.warn).toHaveBeenCalledWith(
      { error: archivalError },
      expect.stringContaining('failed to archive build logs')
    );
  });

  it('archives a build failure when log retrieval and status inspection both fail', async () => {
    const logError = new Error('log stream unavailable');
    const statusError = new Error('Kubernetes API unavailable');
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        ...mockGlobalConfig,
        logArchival: { enabled: true },
      }),
    });
    (waitForJobAndGetLogs as jest.Mock).mockRejectedValue(logError);
    (shellPromise as jest.Mock).mockResolvedValueOnce('').mockRejectedValueOnce(statusError);

    const result = await buildkitBuild(mockDeploy, mockOptions);

    expect(result).toEqual({
      success: false,
      logs: 'Build failed: log stream unavailable',
      jobName: expect.stringMatching(/^test-service-abc123-build-/),
    });
    expect(mockArchiveLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: result.jobName,
        status: 'Failed',
        archivedAt: expect.any(String),
      }),
      'Build failed: log stream unavailable'
    );
    const logger = (getLogger as jest.Mock)();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('status check failed'));
  });

  it('returns the build failure when archiving its error log also fails', async () => {
    const archivalError = new Error('archive store unavailable');
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        ...mockGlobalConfig,
        logArchival: { enabled: true },
      }),
    });
    (waitForJobAndGetLogs as jest.Mock).mockRejectedValue(new Error('build logs unavailable'));
    mockArchiveLogs.mockRejectedValue(archivalError);

    const result = await buildkitBuild(mockDeploy, mockOptions);

    expect(result.success).toBe(false);
    expect(result.logs).toBe('Build failed: build logs unavailable');
    const logger = (getLogger as jest.Mock)();
    expect(logger.warn).toHaveBeenCalledWith(
      { error: archivalError },
      expect.stringContaining('failed to archive build error logs')
    );
  });
});

describe('native build GAR registry auth', () => {
  const garRegistry = 'us-central1-docker.pkg.dev';
  const mockDeploy = {
    deployable: { name: 'test-service' },
    $fetchGraph: jest.fn(),
    build: { isStatic: false },
  } as any;

  const baseOptions: NativeBuildOptions = {
    ecrRepo: 'test-repo',
    ecrDomain: 'registry.internal.svc.cluster.local',
    envVars: { NODE_ENV: 'production' },
    dockerfilePath: 'Dockerfile',
    tag: 'v1.0.0',
    revision: 'abc123def456789',
    repo: 'owner/repo',
    branch: 'main',
    namespace: 'env-test-123',
    buildId: '456',
    buildUuid: 'abc123',
    deployUuid: 'test-service-abc123',
    jobTimeout: 1800,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        buildDefaults: {
          cacheRegistry: `${garRegistry}/project/cache`,
          registryAuth: [{ type: 'gar', registry: garRegistry }],
        },
      }),
    });
    (getGitHubToken as jest.Mock).mockResolvedValue('github-token-123');
    (createNativeBuildRegistryAuthSecret as jest.Mock).mockResolvedValue(undefined);
    (deleteNativeBuildRegistryAuthSecret as jest.Mock).mockResolvedValue(undefined);
    (shellPromise as jest.Mock).mockResolvedValue('');
    (waitForJobAndGetLogs as jest.Mock).mockResolvedValue({
      logs: 'Build completed successfully',
      success: true,
    });
  });

  it('seeds BuildKit with GAR credentials while keeping Distribution output insecure', async () => {
    await buildkitBuild(mockDeploy, baseOptions);

    const createSecretArgs = (createNativeBuildRegistryAuthSecret as jest.Mock).mock.calls[0][0];
    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(createSecretArgs).toEqual(
      expect.objectContaining({
        namespace: 'env-test-123',
        registryAuth: [{ type: 'gar', registry: garRegistry }],
        buildUuid: 'abc123',
        deployUuid: 'test-service-abc123',
      })
    );
    expect(createSecretArgs.secretName).toMatch(/-registry-auth$/);
    expect(fullCommand).toContain('name: "registry-auth-copy"');
    expect(fullCommand).toContain(`secretName: "${createSecretArgs.secretName}"`);
    expect(fullCommand).toContain('mountPath: "/root/.docker"');
    expect(fullCommand).toContain(
      'type=image,name=registry.internal.svc.cluster.local/test-repo:v1.0.0,push=true,registry.insecure=true'
    );
    expect(fullCommand).toContain(`type=registry,ref=${garRegistry}/project/cache/test-repo/test-service/abc123:cache`);
    expect(fullCommand).not.toContain(
      `type=registry,ref=${garRegistry}/project/cache/test-repo/test-service/abc123:cache,insecure=true`
    );
    expect(fullCommand).not.toContain('gar-access-token');
    expect(deleteNativeBuildRegistryAuthSecret).toHaveBeenCalledWith('env-test-123', createSecretArgs.secretName);
  });

  it('keeps GAR output and cache transport secure for BuildKit', async () => {
    await buildkitBuild(mockDeploy, {
      ...baseOptions,
      ecrDomain: garRegistry,
      ecrRepo: 'project/output',
    });

    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain(
      `type=image,name=${garRegistry}/project/output:v1.0.0,push=true,oci-mediatypes=false`
    );
    expect(fullCommand).not.toContain(
      `type=image,name=${garRegistry}/project/output:v1.0.0,push=true,registry.insecure=true`
    );
    expect(fullCommand).not.toContain(
      `type=registry,ref=${garRegistry}/project/cache/test-repo/test-service/abc123:cache,insecure=true`
    );
  });

  it('keeps BuildKit ECR destination login when GAR credentials are configured', async () => {
    await buildkitBuild(mockDeploy, {
      ...baseOptions,
      ecrDomain: '123456789.dkr.ecr.us-east-1.amazonaws.com',
    });

    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('name: "registry-auth-copy"');
    expect(fullCommand).toContain('mountPath: "/root/.docker"');
    expect(fullCommand).toContain('REGISTRY_DOMAIN=\\"123456789.dkr.ecr.us-east-1.amazonaws.com\\"');
    expect(fullCommand).toContain('Detected AWS ECR registry');
    expect(fullCommand).toContain(
      'echo \\"$ECR_PASSWORD\\" | docker login --username AWS --password-stdin ${REGISTRY_DOMAIN}'
    );
    expect(fullCommand).toContain(
      'type=image,name=123456789.dkr.ecr.us-east-1.amazonaws.com/test-repo:v1.0.0,push=true,registry.insecure=true'
    );
  });

  it('cleans the temporary Secret when Job creation fails', async () => {
    (shellPromise as jest.Mock).mockRejectedValue(new Error('kubectl apply failed'));

    await expect(buildkitBuild(mockDeploy, baseOptions)).rejects.toThrow('kubectl apply failed');

    const createSecretArgs = (createNativeBuildRegistryAuthSecret as jest.Mock).mock.calls[0][0];
    expect(deleteNativeBuildRegistryAuthSecret).toHaveBeenCalledWith('env-test-123', createSecretArgs.secretName);
  });

  it('does not create a Job when temporary Secret creation fails', async () => {
    (createNativeBuildRegistryAuthSecret as jest.Mock).mockRejectedValue(new Error('secret creation failed'));

    await expect(buildkitBuild(mockDeploy, baseOptions)).rejects.toThrow('secret creation failed');

    expect(shellPromise).not.toHaveBeenCalled();
    expect(deleteNativeBuildRegistryAuthSecret).not.toHaveBeenCalled();
  });

  it('rejects invalid GAR configuration before creating a Secret or Job', async () => {
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        buildDefaults: {
          registryAuth: [{ type: 'gar', registry: 'https://us-central1-docker.pkg.dev/project/repo' }],
        },
      }),
    });

    await expect(buildkitBuild(mockDeploy, baseOptions)).rejects.toThrow('Build: invalid GAR registry');

    expect(createNativeBuildRegistryAuthSecret).not.toHaveBeenCalled();
    expect(shellPromise).not.toHaveBeenCalled();
  });

  it('seeds Kaniko with GAR credentials without overwriting them for Distribution output', async () => {
    const { kanikoBuild } = require('../engines');
    await kanikoBuild(mockDeploy, baseOptions);

    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('name: "registry-auth-copy"');
    expect(fullCommand).not.toContain('name: "registry-login"');
    expect(fullCommand).toContain('mountPath: "/kaniko/.docker"');
    expect(fullCommand).toContain('--insecure-registry=registry.internal.svc.cluster.local');
    expect(fullCommand).not.toContain(`--insecure-registry=${garRegistry}`);
  });

  it('keeps GAR output and cache transport secure for Kaniko', async () => {
    const { kanikoBuild } = require('../engines');
    await kanikoBuild(mockDeploy, {
      ...baseOptions,
      ecrDomain: garRegistry,
      ecrRepo: 'project/output',
    });

    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).not.toContain('--insecure-registry');
    expect(fullCommand).not.toContain('name: "registry-login"');
    expect(fullCommand).toContain(`--destination=${garRegistry}/project/output:v1.0.0`);
  });

  it('merges GAR credentials with ECR output credentials for Kaniko only when GAR is configured', async () => {
    const { kanikoBuild } = require('../engines');
    await kanikoBuild(mockDeploy, {
      ...baseOptions,
      ecrDomain: '123456789.dkr.ecr.us-east-1.amazonaws.com',
    });

    const applyCall = (shellPromise as jest.Mock).mock.calls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('name: "registry-auth-copy"');
    expect(fullCommand).toContain('name: "registry-login"');
    expect(fullCommand).toContain('> /docker-config/ecr-config.json');
    expect(fullCommand).toContain('name: "registry-auth-merge"');
    expect(fullCommand).toContain('apk add --no-cache jq');
    expect(fullCommand).toContain(
      "jq -s '.[0] * .[1]' /docker-config/config.json /docker-config/ecr-config.json > /docker-config/config.json.tmp"
    );
    expect(fullCommand).not.toContain('--insecure-registry');
  });
});

describe('build resource precedence', () => {
  const mockDeploy = {
    deployable: { name: 'test-service' },
    $fetchGraph: jest.fn(),
    build: { isStatic: false },
  } as any;

  const baseOptions: NativeBuildOptions = {
    ecrRepo: 'test-repo',
    ecrDomain: '123456789.dkr.ecr.us-east-1.amazonaws.com',
    envVars: { NODE_ENV: 'production' },
    dockerfilePath: 'Dockerfile',
    tag: 'v1.0.0',
    revision: 'abc123def456789',
    repo: 'owner/repo',
    branch: 'main',
    namespace: 'env-test-123',
    buildId: '456',
    deployUuid: 'test-service-abc123',
    jobTimeout: 1800,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getGitHubToken as jest.Mock).mockResolvedValue('github-token-123');
    (createNativeBuildRegistryAuthSecret as jest.Mock).mockResolvedValue(undefined);
    (deleteNativeBuildRegistryAuthSecret as jest.Mock).mockResolvedValue(undefined);
    (shellPromise as jest.Mock).mockResolvedValue('');
    (waitForJobAndGetLogs as jest.Mock).mockResolvedValue({
      logs: 'Build completed successfully',
      success: true,
    });
  });

  it('uses yaml resources (options.resources) over global config', async () => {
    const globalConfig = {
      buildDefaults: {
        resources: {
          buildkit: {
            requests: { cpu: '1', memory: '2Gi' },
            limits: { cpu: '2', memory: '4Gi' },
          },
        },
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(globalConfig),
    });

    const yamlResources = {
      requests: { cpu: '4', memory: '8Gi' },
      limits: { cpu: '8', memory: '16Gi' },
    };

    await buildkitBuild(mockDeploy, { ...baseOptions, resources: yamlResources });

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('cpu: "4"');
    expect(fullCommand).toContain('memory: "8Gi"');
    expect(fullCommand).toContain('cpu: "8"');
    expect(fullCommand).toContain('memory: "16Gi"');
    expect(fullCommand).not.toContain('cpu: "1"');
    expect(fullCommand).not.toContain('cpu: "2"');
  });

  it('falls back to global config resources when yaml resources not set', async () => {
    const globalConfig = {
      buildDefaults: {
        resources: {
          buildkit: {
            requests: { cpu: '1', memory: '2Gi' },
            limits: { cpu: '3', memory: '6Gi' },
          },
        },
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(globalConfig),
    });

    await buildkitBuild(mockDeploy, baseOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('cpu: "1"');
    expect(fullCommand).toContain('memory: "2Gi"');
    expect(fullCommand).toContain('cpu: "3"');
    expect(fullCommand).toContain('memory: "6Gi"');
  });

  it('falls back to default resources when neither yaml nor global config set', async () => {
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({}),
    });

    await buildkitBuild(mockDeploy, baseOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('cpu: "500m"');
    expect(fullCommand).toContain('memory: "1Gi"');
    expect(fullCommand).toContain('cpu: "2"');
    expect(fullCommand).toContain('memory: "4Gi"');
  });

  it('uses yaml resources for kaniko over global config', async () => {
    const { kanikoBuild } = require('../engines');
    const globalConfig = {
      buildDefaults: {
        resources: {
          kaniko: {
            requests: { cpu: '300m', memory: '750Mi' },
            limits: { cpu: '1', memory: '2Gi' },
          },
        },
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(globalConfig),
    });

    const yamlResources = {
      requests: { cpu: '2', memory: '4Gi' },
      limits: { cpu: '4', memory: '8Gi' },
    };

    await kanikoBuild(mockDeploy, { ...baseOptions, resources: yamlResources });

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('cpu: "2"');
    expect(fullCommand).toContain('memory: "4Gi"');
    expect(fullCommand).toContain('cpu: "4"');
    expect(fullCommand).toContain('memory: "8Gi"');
    expect(fullCommand).not.toContain('cpu: "300m"');
    expect(fullCommand).not.toContain('memory: "750Mi"');
  });

  it('uses partial yaml resources without merging with global config', async () => {
    const globalConfig = {
      buildDefaults: {
        resources: {
          buildkit: {
            requests: { cpu: '1', memory: '2Gi' },
            limits: { cpu: '2', memory: '4Gi' },
          },
        },
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(globalConfig),
    });

    const yamlResources = {
      requests: { cpu: '4', memory: '8Gi' },
    };

    await buildkitBuild(mockDeploy, { ...baseOptions, resources: yamlResources });

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('cpu: "4"');
    expect(fullCommand).toContain('memory: "8Gi"');
  });
});

describe('build pod annotations', () => {
  const mockDeploy = {
    deployable: { name: 'test-service' },
    $fetchGraph: jest.fn(),
    build: { isStatic: false },
  } as any;

  const baseOptions: NativeBuildOptions = {
    ecrRepo: 'test-repo',
    ecrDomain: '123456789.dkr.ecr.us-east-1.amazonaws.com',
    envVars: { NODE_ENV: 'production' },
    dockerfilePath: 'Dockerfile',
    tag: 'v1.0.0',
    revision: 'abc123def456789',
    repo: 'owner/repo',
    branch: 'main',
    namespace: 'env-test-123',
    buildId: '456',
    deployUuid: 'test-service-abc123',
    jobTimeout: 1800,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getGitHubToken as jest.Mock).mockResolvedValue('github-token-123');
    (createNativeBuildRegistryAuthSecret as jest.Mock).mockResolvedValue(undefined);
    (deleteNativeBuildRegistryAuthSecret as jest.Mock).mockResolvedValue(undefined);
    (shellPromise as jest.Mock).mockResolvedValue('');
    (waitForJobAndGetLogs as jest.Mock).mockResolvedValue({
      logs: 'Build completed successfully',
      success: true,
    });
  });

  it('includes safe-to-evict annotation on pod template by default', async () => {
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({}),
    });

    await buildkitBuild(mockDeploy, baseOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('cluster-autoscaler.kubernetes.io/safe-to-evict: "false"');
  });

  it('applies custom podAnnotations from global config to pod template', async () => {
    const globalConfig = {
      buildDefaults: {
        podAnnotations: {
          'custom-annotation/team': 'platform',
          'custom-annotation/cost-center': 'engineering',
        },
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(globalConfig),
    });

    await buildkitBuild(mockDeploy, baseOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('custom-annotation/team: "platform"');
    expect(fullCommand).toContain('custom-annotation/cost-center: "engineering"');
    expect(fullCommand).toContain('cluster-autoscaler.kubernetes.io/safe-to-evict: "false"');
  });

  it('applies per-service podAnnotations from options', async () => {
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({}),
    });

    await buildkitBuild(mockDeploy, {
      ...baseOptions,
      podAnnotations: { 'my-org/service-tier': 'critical' },
    });

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('my-org/service-tier: "critical"');
    expect(fullCommand).toContain('cluster-autoscaler.kubernetes.io/safe-to-evict: "false"');
  });

  it('per-service podAnnotations override global config podAnnotations', async () => {
    const globalConfig = {
      buildDefaults: {
        podAnnotations: {
          'my-org/team': 'platform',
        },
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(globalConfig),
    });

    await buildkitBuild(mockDeploy, {
      ...baseOptions,
      podAnnotations: { 'my-org/team': 'frontend' },
    });

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('my-org/team: "frontend"');
    expect(fullCommand).not.toContain('my-org/team: "platform"');
  });

  it('hardcoded safe-to-evict cannot be overridden by global config or options', async () => {
    const globalConfig = {
      buildDefaults: {
        podAnnotations: {
          'cluster-autoscaler.kubernetes.io/safe-to-evict': 'true',
        },
      },
    };
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue(globalConfig),
    });

    await buildkitBuild(mockDeploy, {
      ...baseOptions,
      podAnnotations: { 'cluster-autoscaler.kubernetes.io/safe-to-evict': 'true' },
    });

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('cluster-autoscaler.kubernetes.io/safe-to-evict: "false"');
    expect(fullCommand).not.toContain('cluster-autoscaler.kubernetes.io/safe-to-evict: "true"');
  });
});

describe('generateSecretArgsScript', () => {
  it('returns comment when no secret keys provided', () => {
    expect(generateSecretArgsScript(undefined)).toBe('# No secret env keys');
    expect(generateSecretArgsScript([])).toBe('# No secret env keys');
  });

  it('generates shell script for single secret key', () => {
    const result = generateSecretArgsScript(['AWS_SECRET']);
    expect(result).toBe(
      '[ -n "$AWS_SECRET" ] && SECRET_BUILD_ARGS="$SECRET_BUILD_ARGS --opt build-arg:AWS_SECRET=$AWS_SECRET"'
    );
  });

  it('generates shell script for multiple secret keys', () => {
    const result = generateSecretArgsScript(['SECRET_A', 'SECRET_B']);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('SECRET_A');
    expect(lines[1]).toContain('SECRET_B');
  });

  it('produces valid shell syntax', () => {
    const result = generateSecretArgsScript(['MY_SECRET']);
    expect(result).not.toContain('\\$');
    expect(result).toContain('$MY_SECRET');
    expect(result).toContain('--opt build-arg:MY_SECRET=');
  });
});

describe('kaniko registry login bootstrap', () => {
  const mockDeploy = {
    deployable: { name: 'test-service' },
    $fetchGraph: jest.fn(),
    build: { isStatic: false },
  } as any;

  const baseOptions: NativeBuildOptions = {
    ecrRepo: 'test-repo',
    ecrDomain: '123456789.dkr.ecr.us-east-1.amazonaws.com',
    envVars: { NODE_ENV: 'production' },
    dockerfilePath: 'Dockerfile',
    tag: 'v1.0.0',
    revision: 'abc123def456789',
    repo: 'owner/repo',
    branch: 'main',
    namespace: 'env-test-123',
    buildId: '456',
    deployUuid: 'test-service-abc123',
    jobTimeout: 1800,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({}),
    });
    (getGitHubToken as jest.Mock).mockResolvedValue('github-token-123');
    (shellPromise as jest.Mock).mockResolvedValue('');
    (waitForJobAndGetLogs as jest.Mock).mockResolvedValue({
      logs: 'Build completed successfully',
      success: true,
    });
  });

  it('adds AWS retry env vars for ECR login', async () => {
    const { kanikoBuild } = require('../engines');
    await kanikoBuild(mockDeploy, baseOptions);

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('image: "amazon/aws-cli:2.13.0"');
    expect(fullCommand).toContain('export AWS_MAX_ATTEMPTS=5');
    expect(fullCommand).toContain('export AWS_RETRY_MODE=adaptive');
    expect(fullCommand).toContain('aws ecr get-login-password --region us-east-1');
    expect(fullCommand).toContain(
      'echo \'{\\"auths\\":{\\"123456789.dkr.ecr.us-east-1.amazonaws.com\\":{\\"auth\\":\\"\'$(echo -n \\"AWS:$PASSWORD\\" | base64)\'\\"}}}\' > /workspace/.docker/config.json'
    );
    expect(fullCommand).toContain('mountPath: "/kaniko/.docker"');
    expect(fullCommand).toContain('subPath: ".docker"');
    expect(fullCommand).toContain('name: "DOCKER_CONFIG"');
    expect(fullCommand).toContain('value: "/kaniko/.docker"');
  });

  it('keeps non-ECR login bootstrap generic', async () => {
    const { kanikoBuild } = require('../engines');
    await kanikoBuild(mockDeploy, {
      ...baseOptions,
      ecrDomain: 'registry.internal.svc.cluster.local',
    });

    const kubectlCalls = (shellPromise as jest.Mock).mock.calls;
    const applyCall = kubectlCalls.find((call) => call[0].includes('kubectl apply'));
    const fullCommand = applyCall[0];

    expect(fullCommand).toContain('image: "alpine:3.18"');
    expect(fullCommand).toContain('Using in-cluster registry: registry.internal.svc.cluster.local');
    expect(fullCommand).not.toContain('AWS_MAX_ATTEMPTS=5');
  });
});
