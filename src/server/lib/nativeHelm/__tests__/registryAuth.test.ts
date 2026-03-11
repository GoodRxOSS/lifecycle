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

import { detectRegistryAuth, createRegistryAuthInitContainer, generateRegistryLoginScript } from '../registryAuth';

describe('registryAuth', () => {
  describe('detectRegistryAuth', () => {
    it('returns ECR config for a valid ECR OCI URL', () => {
      const result = detectRegistryAuth('oci://123456789012.dkr.ecr.us-west-2.amazonaws.com/my-chart');

      expect(result).toEqual({
        type: 'ecr',
        registry: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
        region: 'us-west-2',
      });
    });

    it('returns undefined for a non-ECR OCI URL', () => {
      const result = detectRegistryAuth('oci://registry-1.docker.io/helm-charts/postgresql');
      expect(result).toBeUndefined();
    });

    it('returns undefined for a non-OCI URL', () => {
      const result = detectRegistryAuth('https://prometheus-community.github.io/helm-charts');
      expect(result).toBeUndefined();
    });

    it('returns undefined when chartRepoUrl is undefined', () => {
      const result = detectRegistryAuth(undefined);
      expect(result).toBeUndefined();
    });

    it('parses the correct region from the ECR URL', () => {
      const result = detectRegistryAuth('oci://123456789012.dkr.ecr.eu-west-1.amazonaws.com/charts/my-app');

      expect(result?.region).toBe('eu-west-1');
      expect(result?.registry).toBe('123456789012.dkr.ecr.eu-west-1.amazonaws.com');
    });
  });

  describe('createRegistryAuthInitContainer', () => {
    it('returns the correct init container spec for ECR', () => {
      const container = createRegistryAuthInitContainer({
        type: 'ecr',
        registry: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
        region: 'us-west-2',
      });

      expect(container.name).toBe('ecr-auth');
      expect(container.image).toBe('amazon/aws-cli:2.22.0');
      expect(container.command).toEqual(['/bin/sh', '-c']);
      expect(container.args[0]).toContain('aws ecr get-login-password --region us-west-2');
      expect(container.args[0]).toContain('/workspace/.helm/ecr-token');
      expect(container.volumeMounts).toEqual([{ name: 'helm-workspace', mountPath: '/workspace' }]);
    });
  });

  describe('generateRegistryLoginScript', () => {
    it('returns the correct helm registry login command for ECR', () => {
      const script = generateRegistryLoginScript({
        type: 'ecr',
        registry: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
        region: 'us-west-2',
      });

      expect(script).toBe(
        'cat /workspace/.helm/ecr-token | helm registry login "123456789012.dkr.ecr.us-west-2.amazonaws.com" --username AWS --password-stdin'
      );
    });
  });
});
