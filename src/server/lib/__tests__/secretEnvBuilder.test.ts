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

import { buildPodEnvWithSecrets, PodEnvEntry } from '../secretEnvBuilder';
import { SecretRefWithEnvKey } from '../secretRefs';

describe('secretEnvBuilder', () => {
  describe('buildPodEnvWithSecrets', () => {
    it('returns regular env vars as direct values', () => {
      const env = {
        APP_ENV: 'production',
        SERVICE_URL: 'https://example.com',
      };

      const result = buildPodEnvWithSecrets(env, [], 'service');

      expect(result).toEqual([
        { name: 'APP_ENV', value: 'production' },
        { name: 'SERVICE_URL', value: 'https://example.com' },
      ]);
    });

    it('returns secret refs as secretKeyRef', () => {
      const env = {
        DB_PASSWORD: '{{aws:myapp/db:password}}',
      };
      const secretRefs: SecretRefWithEnvKey[] = [
        { envKey: 'DB_PASSWORD', provider: 'aws', path: 'myapp/db', key: 'password' },
      ];

      const result = buildPodEnvWithSecrets(env, secretRefs, 'api-server');

      expect(result).toEqual([
        {
          name: 'DB_PASSWORD',
          valueFrom: {
            secretKeyRef: {
              name: 'api-server-aws-secrets',
              key: 'DB_PASSWORD',
            },
          },
        },
      ]);
    });

    it('handles mixed regular and secret env vars', () => {
      const env = {
        APP_ENV: 'production',
        DB_PASSWORD: '{{aws:myapp/db:password}}',
        API_URL: 'https://api.example.com',
        API_KEY: '{{aws:myapp/api-key}}',
      };
      const secretRefs: SecretRefWithEnvKey[] = [
        { envKey: 'DB_PASSWORD', provider: 'aws', path: 'myapp/db', key: 'password' },
        { envKey: 'API_KEY', provider: 'aws', path: 'myapp/api-key', key: undefined },
      ];

      const result = buildPodEnvWithSecrets(env, secretRefs, 'api-server');

      expect(result).toHaveLength(4);

      const appEnv = result.find((e) => e.name === 'APP_ENV') as PodEnvEntry;
      expect(appEnv.value).toBe('production');

      const dbPassword = result.find((e) => e.name === 'DB_PASSWORD') as PodEnvEntry;
      expect(dbPassword.valueFrom?.secretKeyRef?.name).toBe('api-server-aws-secrets');

      const apiUrl = result.find((e) => e.name === 'API_URL') as PodEnvEntry;
      expect(apiUrl.value).toBe('https://api.example.com');

      const apiKey = result.find((e) => e.name === 'API_KEY') as PodEnvEntry;
      expect(apiKey.valueFrom?.secretKeyRef?.name).toBe('api-server-aws-secrets');
    });

    it('handles multiple providers', () => {
      const env = {
        AWS_SECRET: '{{aws:path:key}}',
        GCP_SECRET: '{{gcp:path:key}}',
      };
      const secretRefs: SecretRefWithEnvKey[] = [
        { envKey: 'AWS_SECRET', provider: 'aws', path: 'path', key: 'key' },
        { envKey: 'GCP_SECRET', provider: 'gcp', path: 'path', key: 'key' },
      ];

      const result = buildPodEnvWithSecrets(env, secretRefs, 'service');

      const awsEntry = result.find((e) => e.name === 'AWS_SECRET') as PodEnvEntry;
      expect(awsEntry.valueFrom?.secretKeyRef?.name).toBe('service-aws-secrets');

      const gcpEntry = result.find((e) => e.name === 'GCP_SECRET') as PodEnvEntry;
      expect(gcpEntry.valueFrom?.secretKeyRef?.name).toBe('service-gcp-secrets');
    });

    it('returns empty array for empty input', () => {
      const result = buildPodEnvWithSecrets({}, [], 'service');
      expect(result).toEqual([]);
    });

    it('handles null/undefined env', () => {
      expect(buildPodEnvWithSecrets(null as any, [], 'service')).toEqual([]);
      expect(buildPodEnvWithSecrets(undefined as any, [], 'service')).toEqual([]);
    });
  });
});
