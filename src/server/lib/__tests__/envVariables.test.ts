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

import * as mustache from 'mustache';

describe('envVariables - cloud secret pattern preservation', () => {
  const preserveAndRestoreSecretPatterns = (template: string, data: Record<string, any>): string => {
    const secretPatternRegex = /\{\{(aws|gcp):([^}]+)\}\}/g;
    const secretPlaceholders: Map<string, string> = new Map();
    let placeholderIndex = 0;

    template = template.replace(secretPatternRegex, (match) => {
      const placeholder = `__SECRET_PLACEHOLDER_${placeholderIndex}__`;
      secretPlaceholders.set(placeholder, match);
      placeholderIndex++;
      return placeholder;
    });

    template = template.replace(/{{{?([^{}]*?)}}}?/g, '{{{$1}}}');

    let rendered = mustache.render(template, data);

    for (const [placeholder, original] of secretPlaceholders.entries()) {
      rendered = rendered.replace(placeholder, original);
    }

    return rendered;
  };

  describe('preserves cloud secret patterns', () => {
    it('preserves AWS secret pattern with key', () => {
      const template = '{{aws:myapp/db:password}}';
      const data = {};

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{aws:myapp/db:password}}');
    });

    it('preserves AWS secret pattern without key', () => {
      const template = '{{aws:myapp/api-key}}';
      const data = {};

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{aws:myapp/api-key}}');
    });

    it('preserves GCP secret pattern with key', () => {
      const template = '{{gcp:my-project/secret:key}}';
      const data = {};

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{gcp:my-project/secret:key}}');
    });

    it('preserves GCP secret pattern without key', () => {
      const template = '{{gcp:my-project/api-key}}';
      const data = {};

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{gcp:my-project/api-key}}');
    });

    it('preserves multiple secret patterns', () => {
      const template = '{{aws:path1:key1}} and {{gcp:path2:key2}}';
      const data = {};

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{aws:path1:key1}} and {{gcp:path2:key2}}');
    });

    it('preserves secret patterns while rendering other variables', () => {
      const template = '{{aws:myapp/db:password}} and {{service_url}}';
      const data = { service_url: 'https://example.com' };

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{aws:myapp/db:password}} and https://example.com');
    });

    it('preserves secret patterns in JSON-like structures', () => {
      const template = '{"DB_PASSWORD":"{{aws:myapp/db:password}}","API_URL":"{{api_url}}"}';
      const data = { api_url: 'https://api.example.com' };

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{"DB_PASSWORD":"{{aws:myapp/db:password}}","API_URL":"https://api.example.com"}');
    });

    it('does not affect regular mustache variables', () => {
      const template = '{{service_publicUrl}} and {{buildUUID}}';
      const data = { service_publicUrl: 'https://svc.example.com', buildUUID: 'uuid-123' };

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('https://svc.example.com and uuid-123');
    });

    it('handles nested path with multiple colons in secret pattern', () => {
      const template = '{{aws:myorg/app/nested/secret:database.password}}';
      const data = {};

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{aws:myorg/app/nested/secret:database.password}}');
    });

    it('preserves secret patterns with special characters in path', () => {
      const template = '{{aws:my-app_v2/db-creds:pass_word123}}';
      const data = {};

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{aws:my-app_v2/db-creds:pass_word123}}');
    });

    it('handles empty data object with only secret patterns', () => {
      const template = '{{aws:secret1:key1}}';
      const data = {};

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('{{aws:secret1:key1}}');
    });

    it('handles complex template with mixed patterns', () => {
      const template = 'DB={{aws:db:pass}} HOST={{db_host}} GCP={{gcp:api:token}} PORT={{port}}';
      const data = { db_host: 'localhost', port: '5432' };

      const result = preserveAndRestoreSecretPatterns(template, data);

      expect(result).toBe('DB={{aws:db:pass}} HOST=localhost GCP={{gcp:api:token}} PORT=5432');
    });
  });
});
