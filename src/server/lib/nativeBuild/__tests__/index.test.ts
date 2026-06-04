/**
 * Copyright 2026 Contributors
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

const mockCreateOrUpdateNamespace = jest.fn();
const mockEnsureServiceAccountForJob = jest.fn();
const mockBuildWithEngine = jest.fn();

jest.mock('../../kubernetes', () => ({
  createOrUpdateNamespace: (...args: unknown[]) => mockCreateOrUpdateNamespace(...args),
}));

jest.mock('../../kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: (...args: unknown[]) => mockEnsureServiceAccountForJob(...args),
}));

jest.mock('../engines', () => ({
  buildWithEngine: (...args: unknown[]) => mockBuildWithEngine(...args),
}));

jest.mock('../../buildEngines', () => ({
  isNativeBuilderEngine: jest.fn(() => true),
}));

jest.mock('../../logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  withSpan: jest.fn((_name, fn) => fn()),
}));

import { buildWithNative } from '../index';

describe('buildWithNative', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureServiceAccountForJob.mockResolvedValue('native-build-sa');
    mockBuildWithEngine.mockResolvedValue({
      success: true,
      logs: 'Build completed',
      jobName: 'sample-job',
    });
  });

  it('creates or updates the namespace with TTL metadata before building', async () => {
    const pullRequest = {
      fullName: 'example-org/example-repo',
      pullRequestNumber: 123,
      githubLogin: 'example-author',
      labels: ['deploy-env'],
    };
    const deploy = {
      deployable: {
        name: 'sample-service',
        builder: {
          engine: 'buildkit',
        },
      },
      build: {
        uuid: 'build123',
        isStatic: false,
        pullRequest,
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const options = {
      ecrRepo: 'sample-repo',
      ecrDomain: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
      envVars: {},
      dockerfilePath: 'Dockerfile',
      tag: 'sample-tag',
      revision: 'abcdef1234567890',
      repo: 'example-org/example-repo',
      branch: 'feature-branch',
      namespace: 'env-build123',
      buildId: '1',
      buildUuid: 'build123',
      deployUuid: 'deploy123',
    };

    await buildWithNative(deploy as any, options);

    expect(deploy.$fetchGraph).toHaveBeenCalledWith('[build.[pullRequest]]');
    expect(mockCreateOrUpdateNamespace).toHaveBeenCalledWith({
      name: 'env-build123',
      buildUUID: 'build123',
      staticEnv: false,
      pullRequest,
      waitForReady: true,
    });
    expect(mockEnsureServiceAccountForJob).toHaveBeenCalledWith('env-build123', 'build');
    expect(mockBuildWithEngine).toHaveBeenCalledWith(
      deploy,
      expect.objectContaining({
        serviceAccount: 'native-build-sa',
      }),
      'buildkit'
    );
  });
});
