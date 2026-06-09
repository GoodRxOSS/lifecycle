/**
 * Copyright 2026 GoodRx, Inc.
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

import { validateLifecycleConfigContent } from 'server/services/agent/tools/github/updateFile';
import { extractSchemaPathsFromValidationError, renderLifecycleSchemaSlices } from './schemaSlice';

describe('extractSchemaPathsFromValidationError', () => {
  it('parses dotted and indexed jsonschema paths, dropping array indexes', () => {
    const paths = extractSchemaPathsFromValidationError(
      [
        'instance.services[0].github.repository is not of a type(s) string',
        'instance.environment additionalProperty "bogus" exists in instance when not allowed',
        'instance.services[2].github.repository is not of a type(s) string',
      ].join('\n')
    );

    expect(paths).toEqual(['services.github.repository', 'environment']);
  });

  it('returns nothing for text without schema paths', () => {
    expect(extractSchemaPathsFromValidationError('Could not clone the repository')).toEqual([]);
  });
});

describe('renderLifecycleSchemaSlices', () => {
  it('renders the schema slice for a real type error from the validator', () => {
    const validation = validateLifecycleConfigContent('version: "1.0.0"\nservices: 5\n');
    expect(validation.valid).toBe(false);

    const slices = renderLifecycleSchemaSlices(validation.error || '');
    expect(slices).toContain('- services');
    expect(slices).toContain('type=array');
  });

  it('lists the allowed fields for a real unknown-field error', () => {
    const validation = validateLifecycleConfigContent(
      'version: "1.0.0"\nservices:\n  - name: web\n    bogusField: nope\n'
    );
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('bogusField');

    const slices = renderLifecycleSchemaSlices(validation.error || '');
    expect(slices).toContain('allowed fields:');
    expect(slices).toContain('deploymentDependsOn');
    expect(slices).toContain('(unknown fields rejected)');
  });

  it('returns null when the error carries no schema paths', () => {
    expect(renderLifecycleSchemaSlices('Config file is empty.')).toBeNull();
  });
});
