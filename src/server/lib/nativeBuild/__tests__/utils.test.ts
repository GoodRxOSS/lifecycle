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

import { createGitCloneContainer, createBuildJobManifest } from '../utils';

describe('nativeBuild/utils', () => {
  describe('createGitCloneContainer', () => {
    it('creates a proper git clone container configuration', () => {
      const container = createGitCloneContainer('owner/repo', 'abc123def456', 'x-access-token', 'github-token-123');

      expect(container.name).toBe('git-clone');
      expect(container.image).toBe('alpine/git:latest');
      expect(container.command).toEqual(['sh', '-c']);
      expect(container.args[0]).toContain('git clone');
      expect(container.args[0]).toContain('owner/repo');
      expect(container.args[0]).toContain('abc123def456');

      expect(container.env).toEqual([
        { name: 'GIT_USERNAME', value: 'x-access-token' },
        { name: 'GIT_PASSWORD', value: 'github-token-123' },
      ]);

      expect(container.volumeMounts).toEqual([{ name: 'workspace', mountPath: '/workspace' }]);
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
      expect(manifest.metadata.annotations['lifecycle.io/dockerfile']).toBe('Dockerfile');
      expect(manifest.metadata.annotations['lifecycle.io/ecr-repo']).toBe(
        '123456789.dkr.ecr.us-east-1.amazonaws.com/test-repo'
      );
      expect(manifest.metadata.annotations['lifecycle.io/triggered-at']).toBeDefined();

      // Check spec
      expect(manifest.spec.ttlSecondsAfterFinished).toBe(86400); // 24 hours TTL for all builds
      expect(manifest.spec.backoffLimit).toBe(0);
      expect(manifest.spec.activeDeadlineSeconds).toBe(1800);

      // Check template
      expect(manifest.spec.template.spec.serviceAccountName).toBe('native-build-sa');
      expect(manifest.spec.template.spec.restartPolicy).toBe('Never');
      expect(manifest.spec.template.spec.initContainers).toEqual([{ name: 'git-clone' }]);
      expect(manifest.spec.template.spec.containers).toEqual([{ name: 'buildkit' }]);
      expect(manifest.spec.template.spec.volumes).toEqual([{ name: 'workspace', emptyDir: {} }]);
    });

    it('sets TTL for all builds including static builds', () => {
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
      expect(manifest.spec.ttlSecondsAfterFinished).toBe(86400); // 24 hours for all builds
    });
  });
});
