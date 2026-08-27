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

import { ValidationError, YamlConfigValidator } from 'server/lib/yamlConfigValidator';
import type { McpJsonObject, McpToolDefinition } from '../../../contracts';
import { compileMcpJsonValidator } from '../../../schemaValidator';
import {
  createValidateLifecycleConfigToolDefinition,
  validateLifecycleConfigInputSchema,
  validateLifecycleConfigOutputSchema,
  type ValidateLifecycleConfigToolDependencies,
} from '../validateLifecycleConfig';

const VALID_CONFIG = 'version: "1.0.0"\nservices:\n  - name: web\n';

function callHandler(
  dependencies: ValidateLifecycleConfigToolDependencies,
  input: McpJsonObject
): ReturnType<McpToolDefinition['handler']> {
  return createValidateLifecycleConfigToolDefinition(dependencies).handler(input, {} as never);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('validate lifecycle config schemas and catalog contract', () => {
  it('publishes the stable read-only tool metadata and exported schemas', () => {
    const definition = createValidateLifecycleConfigToolDefinition();

    expect(definition).toMatchObject({
      name: 'validate_lifecycle_config',
      title: 'Validate lifecycle config',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      capabilityId: 'understand-environments',
      access: 'read',
    });
    expect(definition.description).toContain('Content is only checked, never saved or run.');
    expect(definition.inputSchema).toBe(validateLifecycleConfigInputSchema);
    expect(definition.outputSchema).toBe(validateLifecycleConfigOutputSchema);
  });

  it('accepts the exact content and repository limits while rejecting out-of-contract boundaries', () => {
    const validate = compileMcpJsonValidator(validateLifecycleConfigInputSchema);
    const repository = `${'o'.repeat(69)}/${'r'.repeat(70)}`;

    expect(validate({ source: { mode: 'content', content: 'x' } })).toBe(true);
    expect(validate({ source: { mode: 'content', content: 'x'.repeat(204_800) } })).toBe(true);
    expect(validate({ source: { mode: 'content', content: '' } })).toBe(false);
    expect(validate({ source: { mode: 'content', content: 'x'.repeat(204_801) } })).toBe(false);

    expect(validate({ source: { mode: 'repository', repository, branch: 'b'.repeat(255) } })).toBe(true);
    expect(validate({ source: { mode: 'repository', repository: 'missing-slash', branch: 'main' } })).toBe(false);
    expect(validate({ source: { mode: 'repository', repository: 'owner/repo', branch: '' } })).toBe(false);
    expect(validate({ source: { mode: 'content', content: 'x', save: true } })).toBe(false);
  });
});

describe('inline lifecycle config validation', () => {
  it('validates schema-valid YAML without consulting repository dependencies', async () => {
    const findRepository = jest.fn();
    const fetchRepositoryContent = jest.fn();

    await expect(
      callHandler(
        { findRepository, fetchRepositoryContent },
        {
          source: { mode: 'content', content: VALID_CONFIG },
        }
      )
    ).resolves.toEqual({ valid: true, errors: [] });

    expect(findRepository).not.toHaveBeenCalled();
    expect(fetchRepositoryContent).not.toHaveBeenCalled();
  });

  it('returns a path-specific issue for schema-invalid YAML', async () => {
    const result = await callHandler(
      {},
      {
        source: { mode: 'content', content: 'version: "1.0.0"\nservices: 5\n' },
      }
    );

    expect(result).toEqual({
      valid: false,
      errors: [{ path: 'services', message: 'is not of a type(s) array' }],
    });
  });

  it('reports whitespace-only YAML as an invalid root configuration', async () => {
    const result = await callHandler({}, { source: { mode: 'content', content: '   ' } });

    expect(result).toEqual({
      valid: false,
      errors: [{ path: '$', message: 'Config file is empty.' }],
    });
  });

  it('returns a single root issue for malformed YAML syntax', async () => {
    const result = await callHandler(
      {},
      {
        source: { mode: 'content', content: 'version: "1.0.0"\nservices: [' },
      }
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([{ path: '$', message: expect.stringContaining('unexpected end of the stream') }]);
  });

  it('normalizes multiline validator errors, array indexes, and unsafe empty text', async () => {
    jest.spyOn(YamlConfigValidator.prototype, 'validate').mockImplementation(() => {
      throw new ValidationError(
        [
          'instance.services.0.name is required',
          'instance root is invalid',
          '',
          'instance.\u001b[31m\u001b[0m \u001b[32m\u001b[0m',
        ].join('\n')
      );
    });

    const result = await callHandler({}, { source: { mode: 'content', content: VALID_CONFIG } });

    expect(result).toEqual({
      valid: false,
      errors: [
        { path: 'services[0].name', message: 'is required' },
        { path: '$', message: 'root is invalid' },
        { path: '$', message: 'The configuration is invalid.' },
        { path: '$', message: 'The configuration is invalid.' },
      ],
    });
  });

  it('maps an unexpected validator failure to a safe internal error', async () => {
    jest.spyOn(YamlConfigValidator.prototype, 'validate').mockImplementation(() => {
      throw new Error('sensitive validator failure');
    });

    await expect(callHandler({}, { source: { mode: 'content', content: VALID_CONFIG } })).rejects.toMatchObject({
      name: 'McpExecutionError',
      code: 'internal_error',
      message: 'Lifecycle could not complete this request. Ask an administrator for help.',
    });
  });

  it('bounds and sanitizes dependency-provided issues before returning them', async () => {
    const findRepository = jest.fn();
    const fetchRepositoryContent = jest.fn();
    const errors = [
      { path: '', message: '' },
      { path: '\u001b[31m$.services[0]\u001b[0m', message: '\u001b[31mbad field\u001b[0m' },
      { path: 'é'.repeat(400), message: 'm'.repeat(600) },
      ...Array.from({ length: 48 }, (_, index) => ({ path: `$.field${index}`, message: `issue-${index}` })),
    ];
    const validateContent = jest.fn().mockResolvedValue({ valid: false, errors });

    const result = await callHandler(
      { findRepository, fetchRepositoryContent, validateContent },
      {
        source: { mode: 'content', content: 'candidate YAML' },
      }
    );

    expect(validateContent).toHaveBeenCalledWith('candidate YAML');
    expect(findRepository).not.toHaveBeenCalled();
    expect(fetchRepositoryContent).not.toHaveBeenCalled();
    const resultErrors = result.errors as McpJsonObject[];
    expect(resultErrors).toHaveLength(50);
    expect(resultErrors.slice(0, 2)).toEqual([
      { path: '$', message: 'The configuration is invalid.' },
      { path: '$.services[0]', message: 'bad field' },
    ]);
    expect(Buffer.byteLength(resultErrors[2].path as string, 'utf8')).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(resultErrors[2].message as string, 'utf8')).toBeLessThanOrEqual(500);
    expect(resultErrors[49]).toEqual({ path: '$.field46', message: 'issue-46' });
  });
});

describe('repository lifecycle config validation', () => {
  it('fetches the canonical onboarded repository and validates its committed content', async () => {
    const findRepository = jest.fn().mockResolvedValue({
      githubRepositoryId: 7,
      fullName: 'GoodRx/Canonical',
      defaultEnvId: null,
    });
    const fetchRepositoryContent = jest.fn().mockResolvedValue(VALID_CONFIG);
    const validateContent = jest.fn().mockResolvedValue({ valid: true, errors: [] });

    await expect(
      callHandler(
        { findRepository, fetchRepositoryContent, validateContent },
        {
          source: { mode: 'repository', repository: 'goodrx/canonical', branch: 'feature/test' },
        }
      )
    ).resolves.toEqual({ valid: true, errors: [] });

    expect(findRepository).toHaveBeenCalledWith('goodrx/canonical');
    expect(fetchRepositoryContent).toHaveBeenCalledWith('GoodRx/Canonical', 'feature/test');
    expect(validateContent).toHaveBeenCalledWith(VALID_CONFIG);
  });

  it('reports an unonboarded repository without fetching or validating content', async () => {
    const findRepository = jest.fn().mockResolvedValue(null);
    const fetchRepositoryContent = jest.fn();
    const validateContent = jest.fn();

    await expect(
      callHandler(
        { findRepository, fetchRepositoryContent, validateContent },
        {
          source: { mode: 'repository', repository: 'goodrx/missing', branch: 'main' },
        }
      )
    ).rejects.toMatchObject({
      name: 'McpExecutionError',
      code: 'repo_not_onboarded',
      message: 'That repository is not onboarded. Call list_repositories to see repositories you can use.',
    });
    expect(fetchRepositoryContent).not.toHaveBeenCalled();
    expect(validateContent).not.toHaveBeenCalled();
  });

  it('maps a repository read failure to upstream unavailability without validating', async () => {
    const findRepository = jest.fn().mockResolvedValue({
      githubRepositoryId: 7,
      fullName: 'goodrx/example',
      defaultEnvId: null,
    });
    const fetchRepositoryContent = jest.fn().mockRejectedValue(new Error('GitHub unavailable'));
    const validateContent = jest.fn();

    await expect(
      callHandler(
        { findRepository, fetchRepositoryContent, validateContent },
        {
          source: { mode: 'repository', repository: 'goodrx/example', branch: 'main' },
        }
      )
    ).rejects.toMatchObject({
      name: 'McpExecutionError',
      code: 'upstream_unavailable',
      message: 'Lifecycle could not read lifecycle.yaml from GitHub. Retry this request later.',
    });
    expect(validateContent).not.toHaveBeenCalled();
  });

  it('maps an unexpected repository lookup failure to a safe internal error', async () => {
    const findRepository = jest.fn().mockRejectedValue(new Error('database details'));
    const fetchRepositoryContent = jest.fn();
    const validateContent = jest.fn();

    await expect(
      callHandler(
        { findRepository, fetchRepositoryContent, validateContent },
        {
          source: { mode: 'repository', repository: 'goodrx/example', branch: 'main' },
        }
      )
    ).rejects.toMatchObject({
      name: 'McpExecutionError',
      code: 'internal_error',
      message: 'Lifecycle could not complete this request. Ask an administrator for help.',
    });
    expect(fetchRepositoryContent).not.toHaveBeenCalled();
    expect(validateContent).not.toHaveBeenCalled();
  });
});
