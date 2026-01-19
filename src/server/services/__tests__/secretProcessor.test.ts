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

import { SecretProcessor } from '../secretProcessor';
import { SecretProvidersConfig } from 'server/services/types/globalConfig';

jest.mock('server/lib/kubernetes/externalSecret', () => ({
  applyExternalSecret: jest.fn().mockResolvedValue(undefined),
  generateExternalSecretManifest: jest.requireActual('server/lib/kubernetes/externalSecret')
    .generateExternalSecretManifest,
  generateSecretName: jest.requireActual('server/lib/kubernetes/externalSecret').generateSecretName,
  groupSecretRefsByProvider: jest.requireActual('server/lib/kubernetes/externalSecret').groupSecretRefsByProvider,
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('SecretProcessor', () => {
  const secretProviders: SecretProvidersConfig = {
    aws: {
      enabled: true,
      clusterSecretStore: 'aws-secretsmanager',
      refreshInterval: '1h',
    },
    gcp: {
      enabled: false,
      clusterSecretStore: 'gcp-sm',
      refreshInterval: '1h',
    },
  };

  let processor: SecretProcessor;

  beforeEach(() => {
    processor = new SecretProcessor(secretProviders);
    jest.clearAllMocks();
  });

  describe('waitForSecretSync', () => {
    it('resolves when secret exists with data', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: {
          data: { key: 'dmFsdWU=' },
        },
      });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      await expect(processor.waitForSecretSync(['my-secret'], 'test-ns', 5000)).resolves.toBeUndefined();

      expect(mockReadNamespacedSecret).toHaveBeenCalledWith('my-secret', 'test-ns');
    });

    it('throws error on timeout when secret does not exist', async () => {
      const mockReadNamespacedSecret = jest.fn().mockRejectedValue({ statusCode: 404 });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      await expect(processor.waitForSecretSync(['my-secret'], 'test-ns', 1000)).rejects.toThrow('Secret sync timeout');
    });

    it('throws error on timeout when secret has no data', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: { data: null },
      });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      await expect(processor.waitForSecretSync(['my-secret'], 'test-ns', 1000)).rejects.toThrow('Secret sync timeout');
    });

    it('waits for multiple secrets', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: { data: { key: 'dmFsdWU=' } },
      });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      await processor.waitForSecretSync(['secret-1', 'secret-2'], 'test-ns', 5000);

      expect(mockReadNamespacedSecret).toHaveBeenCalledWith('secret-1', 'test-ns');
      expect(mockReadNamespacedSecret).toHaveBeenCalledWith('secret-2', 'test-ns');
    });
  });

  describe('processEnvSecrets', () => {
    it('extracts and validates secret references', async () => {
      const env = {
        DB_PASSWORD: '{{aws:myapp/db:password}}',
        APP_ENV: 'production',
      };

      const result = await processor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
        buildUuid: 'abc123',
      });

      expect(result.secretRefs).toHaveLength(1);
      expect(result.secretRefs[0].envKey).toBe('DB_PASSWORD');
      expect(result.warnings).toHaveLength(0);
    });

    it('returns warning for disabled provider', async () => {
      const env = {
        GCP_SECRET: '{{gcp:path:key}}',
      };

      const result = await processor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result.secretRefs).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('disabled');
    });

    it('returns warning for unconfigured provider', async () => {
      const limitedConfig: SecretProvidersConfig = {
        aws: { enabled: true, clusterSecretStore: 'aws-sm', refreshInterval: '1h' },
      };
      const limitedProcessor = new SecretProcessor(limitedConfig);

      const env = {
        GCP_SECRET: '{{gcp:path:key}}',
      };

      const result = await limitedProcessor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result.secretRefs).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('not configured');
    });

    it('creates ExternalSecrets for valid refs', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');

      const env = {
        DB_PASSWORD: '{{aws:myapp/db:password}}',
        DB_USER: '{{aws:myapp/db:username}}',
      };

      await processor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
        buildUuid: 'abc123',
      });

      expect(applyExternalSecret).toHaveBeenCalledTimes(1);
      expect(applyExternalSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'api-server-aws-secrets',
          }),
        }),
        'lfc-abc123'
      );
    });

    it('creates separate ExternalSecrets for multiple providers', async () => {
      const multiProviderConfig: SecretProvidersConfig = {
        aws: { enabled: true, clusterSecretStore: 'aws-sm', refreshInterval: '1h' },
        gcp: { enabled: true, clusterSecretStore: 'gcp-sm', refreshInterval: '1h' },
      };
      const multiProcessor = new SecretProcessor(multiProviderConfig);
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');

      const env = {
        AWS_SECRET: '{{aws:path:key}}',
        GCP_SECRET: '{{gcp:path:key}}',
      };

      await multiProcessor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'ns',
      });

      expect(applyExternalSecret).toHaveBeenCalledTimes(2);
    });

    it('handles empty env', async () => {
      const result = await processor.processEnvSecrets({
        env: {},
        serviceName: 'api-server',
        namespace: 'ns',
      });

      expect(result.secretRefs).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('returns warning when ExternalSecret apply fails', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      applyExternalSecret.mockRejectedValueOnce(new Error('kubectl failed'));

      const env = {
        DB_PASSWORD: '{{aws:myapp/db:password}}',
      };

      const result = await processor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result.secretRefs).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Failed to apply ExternalSecret');
    });

    it('returns secret names for mounting', async () => {
      const env = {
        AWS_SECRET: '{{aws:path:key}}',
        GCP_SECRET: '{{gcp:path:key}}',
      };

      const multiProcessor = new SecretProcessor({
        aws: { enabled: true, clusterSecretStore: 'aws-sm', refreshInterval: '1h' },
        gcp: { enabled: true, clusterSecretStore: 'gcp-sm', refreshInterval: '1h' },
      });

      const result = await multiProcessor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'ns',
      });

      expect(result.secretNames).toContain('api-server-aws-secrets');
      expect(result.secretNames).toContain('api-server-gcp-secrets');
    });
  });
});
