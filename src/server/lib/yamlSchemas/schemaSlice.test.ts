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

  it('describes enum, format, minimum, and array-item constraints at exact paths', () => {
    const slices = renderLifecycleSchemaSlices(
      [
        'instance.services[0].helm.deploymentMethod is invalid',
        'instance.version is invalid',
        'instance.services[0].dev.agentSession.skills[0].repo is invalid',
        'instance.services[0].dev.agentSession.readiness.timeoutMs is invalid',
      ].join('\n')
    );

    expect(slices).toContain('- services.helm.deploymentMethod: type=string, enum=[native, ci]');
    expect(slices).toContain('- version: type=string, format=schema100Version');
    expect(slices).toContain('- services.dev.agentSession.skills.repo: type=string, minLength=1');
    expect(slices).toContain('- services.dev.agentSession.readiness.timeoutMs: type=integer, minimum=0');
  });

  it('labels the nearest schema node when an error path contains an unknown field', () => {
    const slices = renderLifecycleSchemaSlices('instance.services[0].dockerfle is not allowed');

    expect(slices).toContain('- services (nearest schema match for services.dockerfle):');
    expect(slices).toContain('allowed fields:');
  });

  it('reports omitted paths after the bounded four-slice limit', () => {
    const slices = renderLifecycleSchemaSlices(
      [
        'instance.version is invalid',
        'instance.environment.autoDeploy is invalid',
        'instance.environment.ignoreFiles is invalid',
        'instance.environment.enabledFeatures is invalid',
        'instance.environment.githubDeployments is invalid',
      ].join('\n')
    );

    expect(slices).toContain('- (+1 more failing paths)');
  });

  it('bounds verbose nearest-match descriptions', () => {
    const longUnknownField = 'x'.repeat(400);
    const slices = renderLifecycleSchemaSlices(
      [
        `instance.services[0].${longUnknownField}One is invalid`,
        `instance.services[0].${longUnknownField}Two is invalid`,
        `instance.services[0].${longUnknownField}Three is invalid`,
        `instance.services[0].${longUnknownField}Four is invalid`,
      ].join('\n')
    );

    expect(slices).toHaveLength(1501);
    expect(slices?.endsWith('…')).toBe(true);
  });
});
