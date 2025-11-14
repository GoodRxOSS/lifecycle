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

import { buildkitBuild, BuildkitBuildOptions } from '../engines';
import { shellPromise } from '../../shell';
import { waitForJobAndGetLogs, getGitHubToken } from '../utils';
import GlobalConfigService from '../../../services/globalConfig';

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
    __esModule: true,
    default: mockLogger,
  };
});

describe('buildkitBuild', () => {
  const mockDeploy = {
    deployable: { name: 'test-service' },
    $fetchGraph: jest.fn(),
    build: { isStatic: false },
  } as any;

  const mockOptions: BuildkitBuildOptions = {
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

    // Check cache uses local distribution registry with service name to avoid collisions
    expect(fullCommand).toContain(
      'ref=lifecycle-distribution.lifecycle-app.svc.cluster.local/test-repo/test-service:cache'
    );

    // Check custom resources are applied
    expect(fullCommand).toContain('cpu: "1"');
    expect(fullCommand).toContain('memory: "2Gi"');
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

  it('uses correct job naming pattern', async () => {
    const result = await buildkitBuild(mockDeploy, mockOptions);

    // Job name should follow pattern: {deployUuid}-build-{jobId}-{shortSha}
    expect(result.jobName).toMatch(/^test-service-abc123-build-[a-z0-9]{5}-abc123d$/);
    expect(result.jobName.length).toBeLessThanOrEqual(63); // Kubernetes name limit
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
    expect(fullCommand).toContain('lifecycle.io/dockerfile: "Dockerfile"');
    expect(fullCommand).toContain('lifecycle.io/ecr-repo: "test-repo"');
  });
});
