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

import { parseSecretRef, parseSecretRefsFromEnv, isSecretRef, validateSecretRef, SecretRef } from '../secretRefs';

describe('secretRefs', () => {
  describe('isSecretRef', () => {
    it('returns true for valid AWS secret reference', () => {
      expect(isSecretRef('{{aws:myapp/db:password}}')).toBe(true);
    });

    it('returns true for valid GCP secret reference', () => {
      expect(isSecretRef('{{gcp:my-project/secret:key}}')).toBe(true);
    });

    it('returns true for secret without key (plaintext)', () => {
      expect(isSecretRef('{{aws:myapp/api-key}}')).toBe(true);
    });

    it('returns false for regular template variable', () => {
      expect(isSecretRef('{{service_publicUrl}}')).toBe(false);
    });

    it('returns false for triple-brace template', () => {
      expect(isSecretRef('{{{buildUUID}}}')).toBe(false);
    });

    it('returns false for static value', () => {
      expect(isSecretRef('static-value')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isSecretRef('')).toBe(false);
    });
  });

  describe('parseSecretRef', () => {
    it('parses AWS secret with key', () => {
      const result = parseSecretRef('{{aws:myapp/rds-credentials:password}}');
      expect(result).toEqual({
        provider: 'aws',
        path: 'myapp/rds-credentials',
        key: 'password',
      });
    });

    it('parses AWS secret without key (plaintext)', () => {
      const result = parseSecretRef('{{aws:myapp/api-key}}');
      expect(result).toEqual({
        provider: 'aws',
        path: 'myapp/api-key',
        key: undefined,
      });
    });

    it('parses GCP secret with key', () => {
      const result = parseSecretRef('{{gcp:my-project/db-creds:password}}');
      expect(result).toEqual({
        provider: 'gcp',
        path: 'my-project/db-creds',
        key: 'password',
      });
    });

    it('parses nested key with dot notation', () => {
      const result = parseSecretRef('{{aws:myapp/config:database.password}}');
      expect(result).toEqual({
        provider: 'aws',
        path: 'myapp/config',
        key: 'database.password',
      });
    });

    it('returns null for non-secret reference', () => {
      expect(parseSecretRef('{{service_publicUrl}}')).toBeNull();
      expect(parseSecretRef('static-value')).toBeNull();
    });

    it('returns null for invalid syntax with trailing colon', () => {
      expect(parseSecretRef('{{aws:path:}}')).toBeNull();
    });

    it('returns null for whitespace in pattern', () => {
      expect(parseSecretRef('{{ aws:path:key }}')).toBeNull();
    });
  });

  describe('validateSecretRef', () => {
    const enabledConfig = {
      aws: {
        enabled: true,
        clusterSecretStore: 'aws-sm',
        refreshInterval: '1h',
      },
    };

    const disabledConfig = {
      aws: {
        enabled: false,
        clusterSecretStore: 'aws-sm',
        refreshInterval: '1h',
      },
    };

    const configWithPrefixes = {
      aws: {
        enabled: true,
        clusterSecretStore: 'aws-sm',
        refreshInterval: '1h',
        allowedPrefixes: ['myorg/', 'shared/'],
      },
    };

    it('returns valid for enabled provider', () => {
      const ref: SecretRef = { provider: 'aws', path: 'myapp/secret', key: 'key' };
      const result = validateSecretRef(ref, enabledConfig);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns invalid for unconfigured provider', () => {
      const ref: SecretRef = { provider: 'gcp', path: 'path', key: 'key' };
      const result = validateSecretRef(ref, enabledConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('returns invalid for disabled provider', () => {
      const ref: SecretRef = { provider: 'aws', path: 'path', key: 'key' };
      const result = validateSecretRef(ref, disabledConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('returns valid for path matching allowed prefix', () => {
      const ref: SecretRef = { provider: 'aws', path: 'myorg/app/secret', key: 'key' };
      const result = validateSecretRef(ref, configWithPrefixes);
      expect(result.valid).toBe(true);
    });

    it('returns invalid for path not matching allowed prefixes', () => {
      const ref: SecretRef = { provider: 'aws', path: 'other/secret', key: 'key' };
      const result = validateSecretRef(ref, configWithPrefixes);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not in allowed prefixes');
    });

    it('allows any path when allowedPrefixes is empty', () => {
      const ref: SecretRef = { provider: 'aws', path: 'any/path', key: 'key' };
      const result = validateSecretRef(ref, enabledConfig);
      expect(result.valid).toBe(true);
    });
  });

  describe('parseSecretRefsFromEnv', () => {
    it('extracts secret references from env object', () => {
      const env = {
        DB_PASSWORD: '{{aws:myapp/db:password}}',
        DB_HOST: 'localhost',
        API_KEY: '{{aws:myapp/api-key}}',
        SERVICE_URL: '{{backend_publicUrl}}',
      };

      const result = parseSecretRefsFromEnv(env);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({
        envKey: 'DB_PASSWORD',
        provider: 'aws',
        path: 'myapp/db',
        key: 'password',
      });
      expect(result).toContainEqual({
        envKey: 'API_KEY',
        provider: 'aws',
        path: 'myapp/api-key',
        key: undefined,
      });
    });

    it('returns empty array for env without secrets', () => {
      const env = {
        APP_ENV: 'production',
        SERVICE_URL: '{{backend_publicUrl}}',
      };

      const result = parseSecretRefsFromEnv(env);
      expect(result).toEqual([]);
    });

    it('handles empty env object', () => {
      const result = parseSecretRefsFromEnv({});
      expect(result).toEqual([]);
    });

    it('handles null/undefined env', () => {
      expect(parseSecretRefsFromEnv(null as any)).toEqual([]);
      expect(parseSecretRefsFromEnv(undefined as any)).toEqual([]);
    });

    it('extracts from multiple providers', () => {
      const env = {
        AWS_SECRET: '{{aws:path:key}}',
        GCP_SECRET: '{{gcp:path:key}}',
      };

      const result = parseSecretRefsFromEnv(env);

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.provider)).toContain('aws');
      expect(result.map((r) => r.provider)).toContain('gcp');
    });
  });
});
