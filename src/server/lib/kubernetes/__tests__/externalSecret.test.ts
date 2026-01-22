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

import { generateExternalSecretManifest, generateSecretName, groupSecretRefsByProvider } from '../externalSecret';
import { SecretRefWithEnvKey } from 'server/lib/secretRefs';

describe('externalSecret', () => {
  describe('generateSecretName', () => {
    it('generates name with provider suffix', () => {
      expect(generateSecretName('api-server', 'aws')).toBe('api-server-aws-secrets');
    });

    it('generates name for gcp provider', () => {
      expect(generateSecretName('worker', 'gcp')).toBe('worker-gcp-secrets');
    });

    it('truncates long names to 63 characters', () => {
      const longName = 'this-is-a-very-long-service-name-that-exceeds-the-limit';
      const result = generateSecretName(longName, 'aws');
      expect(result.length).toBeLessThanOrEqual(63);
      expect(result).toMatch(/-aws-secrets$/);
    });

    it('removes trailing hyphen after truncation', () => {
      const longName = 'service-name-that-ends-at-truncation-point-exactly-here';
      const result = generateSecretName(longName, 'aws');
      expect(result).not.toMatch(/-$/);
    });
  });

  describe('groupSecretRefsByProvider', () => {
    it('groups refs by provider', () => {
      const refs: SecretRefWithEnvKey[] = [
        { envKey: 'AWS_VAR1', provider: 'aws', path: 'path1', key: 'key1' },
        { envKey: 'GCP_VAR', provider: 'gcp', path: 'path2', key: 'key2' },
        { envKey: 'AWS_VAR2', provider: 'aws', path: 'path3', key: 'key3' },
      ];

      const result = groupSecretRefsByProvider(refs);

      expect(Object.keys(result)).toEqual(['aws', 'gcp']);
      expect(result.aws).toHaveLength(2);
      expect(result.gcp).toHaveLength(1);
    });

    it('returns empty object for empty input', () => {
      expect(groupSecretRefsByProvider([])).toEqual({});
    });
  });

  describe('generateExternalSecretManifest', () => {
    const providerConfig = {
      enabled: true,
      clusterSecretStore: 'aws-secretsmanager',
      refreshInterval: '1h',
    };

    it('generates valid ExternalSecret manifest', () => {
      const refs: SecretRefWithEnvKey[] = [
        { envKey: 'DB_PASSWORD', provider: 'aws', path: 'myapp/db', key: 'password' },
        { envKey: 'DB_USER', provider: 'aws', path: 'myapp/db', key: 'username' },
      ];

      const manifest = generateExternalSecretManifest({
        name: 'api-server',
        namespace: 'lfc-abc123',
        provider: 'aws',
        secretRefs: refs,
        providerConfig,
      });

      expect(manifest.apiVersion).toBe('external-secrets.io/v1beta1');
      expect(manifest.kind).toBe('ExternalSecret');
      expect(manifest.metadata.name).toBe('api-server-aws-secrets');
      expect(manifest.metadata.namespace).toBe('lfc-abc123');
      expect(manifest.spec.refreshInterval).toBe('1h');
      expect(manifest.spec.secretStoreRef.name).toBe('aws-secretsmanager');
      expect(manifest.spec.secretStoreRef.kind).toBe('ClusterSecretStore');
      expect(manifest.spec.target.name).toBe('api-server-aws-secrets');
      expect(manifest.spec.data).toHaveLength(2);
    });

    it('generates correct data entries for JSON secrets', () => {
      const refs: SecretRefWithEnvKey[] = [
        { envKey: 'DB_PASSWORD', provider: 'aws', path: 'myapp/db', key: 'password' },
      ];

      const manifest = generateExternalSecretManifest({
        name: 'api-server',
        namespace: 'ns',
        provider: 'aws',
        secretRefs: refs,
        providerConfig,
      });

      expect(manifest.spec.data[0]).toEqual({
        secretKey: 'DB_PASSWORD',
        remoteRef: {
          key: 'myapp/db',
          property: 'password',
        },
      });
    });

    it('generates correct data entry for plaintext secret (no key)', () => {
      const refs: SecretRefWithEnvKey[] = [
        { envKey: 'API_KEY', provider: 'aws', path: 'myapp/api-key', key: undefined },
      ];

      const manifest = generateExternalSecretManifest({
        name: 'api-server',
        namespace: 'ns',
        provider: 'aws',
        secretRefs: refs,
        providerConfig,
      });

      expect(manifest.spec.data[0]).toEqual({
        secretKey: 'API_KEY',
        remoteRef: {
          key: 'myapp/api-key',
        },
      });
    });

    it('handles nested key with dot notation', () => {
      const refs: SecretRefWithEnvKey[] = [
        { envKey: 'REDIS_HOST', provider: 'aws', path: 'config', key: 'redis.host' },
      ];

      const manifest = generateExternalSecretManifest({
        name: 'api-server',
        namespace: 'ns',
        provider: 'aws',
        secretRefs: refs,
        providerConfig,
      });

      expect(manifest.spec.data[0].remoteRef.property).toBe('redis.host');
    });

    it('includes lifecycle labels', () => {
      const refs: SecretRefWithEnvKey[] = [{ envKey: 'SECRET', provider: 'aws', path: 'path', key: 'key' }];

      const manifest = generateExternalSecretManifest({
        name: 'api-server',
        namespace: 'lfc-abc123',
        provider: 'aws',
        secretRefs: refs,
        providerConfig,
        buildUuid: 'abc123',
      });

      expect(manifest.metadata.labels['app.kubernetes.io/managed-by']).toBe('lifecycle');
      expect(manifest.metadata.labels['lfc/uuid']).toBe('abc123');
    });
  });
});
