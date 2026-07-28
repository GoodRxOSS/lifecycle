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

import { getYamlFileContentFromBranch } from 'server/lib/github';
import { EmptyFileError, ParsingError, YamlConfigParser } from 'server/lib/yamlConfigParser';
import { ValidationError, YamlConfigValidator } from 'server/lib/yamlConfigValidator';
import type { McpJsonObject, McpToolDefinition } from '../../contracts';
import { McpExecutionError } from '../../errors';
import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';
import { defaultFindRepository, mapCoreToolError, safeCoreText, type CoreRepositoryRecord } from './listRepositories';

const DESCRIPTION =
  'Checks a lifecycle.yaml against the schema and returns every problem with its location. Use `source.mode: "content"` for text you are editing, or `source.mode: "repository"` for what is committed. Content is only checked, never saved or run.';

export interface LifecycleValidationIssue {
  path: string;
  message: string;
}

export interface ValidateLifecycleConfigToolDependencies {
  findRepository?: (fullName: string) => Promise<CoreRepositoryRecord | null>;
  fetchRepositoryContent?: (repository: string, branch: string) => Promise<string>;
  validateContent?: (content: string) => Promise<{ valid: boolean; errors: LifecycleValidationIssue[] }>;
}

const contentSourceSchema = closedObjectSchema(
  {
    mode: { type: 'string', const: 'content' },
    content: { type: 'string', minLength: 1, maxLength: 204800 },
  },
  ['mode', 'content']
);

const repositorySourceSchema = closedObjectSchema(
  {
    mode: { type: 'string', const: 'repository' },
    repository: {
      type: 'string',
      maxLength: 140,
      pattern: '^[^/]+/[^/]+$',
    },
    branch: { type: 'string', minLength: 1, maxLength: 255 },
  },
  ['mode', 'repository', 'branch']
);

export const validateLifecycleConfigInputSchema = closedObjectSchema(
  {
    source: { oneOf: [contentSourceSchema, repositorySourceSchema] },
  },
  ['source']
);

export const validateLifecycleConfigOutputSchema = successObjectSchema(
  {
    valid: { type: 'boolean' },
    errors: {
      type: 'array',
      minItems: 0,
      maxItems: 50,
      items: closedObjectSchema(
        {
          path: { type: 'string', minLength: 1, maxLength: 500 },
          message: { type: 'string', minLength: 1, maxLength: 500 },
        },
        ['path', 'message']
      ),
    },
  },
  ['valid', 'errors']
);

function pathAndMessage(line: string): LifecycleValidationIssue {
  const trimmed = line.trim();
  const match = trimmed.match(/^instance(?:\.([^\s]+))?\s+(.+)$/);
  if (!match) {
    return {
      path: '$',
      message: safeCoreText(trimmed || 'The configuration is invalid.', 500),
    };
  }
  const path = (match[1] || '$').replace(/\.(\d+)(?=\.|$)/g, '[$1]');
  return {
    path: safeCoreText(path, 500) || '$',
    message: safeCoreText(match[2], 500) || 'The configuration is invalid.',
  };
}

async function defaultValidateContent(
  content: string
): Promise<{ valid: boolean; errors: LifecycleValidationIssue[] }> {
  try {
    const config = new YamlConfigParser().parseYamlConfigFromString(content);
    new YamlConfigValidator().validate(config?.version, config);
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof ValidationError) {
      const errors = error.message
        .split('\n')
        .map(pathAndMessage)
        .filter((entry) => entry.message)
        .slice(0, 50);
      return {
        valid: false,
        errors,
      };
    }
    if (error instanceof ParsingError || error instanceof EmptyFileError) {
      return {
        valid: false,
        errors: [
          {
            path: '$',
            message: safeCoreText(error.message, 500) || 'The configuration could not be parsed as YAML.',
          },
        ],
      };
    }
    throw error;
  }
}

export function createValidateLifecycleConfigToolDefinition(
  dependencies: ValidateLifecycleConfigToolDependencies = {}
): McpToolDefinition {
  const findRepository = dependencies.findRepository ?? defaultFindRepository;
  const fetchRepositoryContent = dependencies.fetchRepositoryContent ?? getYamlFileContentFromBranch;
  const validateContent = dependencies.validateContent ?? defaultValidateContent;
  return {
    name: 'validate_lifecycle_config',
    title: 'Validate lifecycle config',
    description: DESCRIPTION,
    inputSchema: validateLifecycleConfigInputSchema,
    outputSchema: validateLifecycleConfigOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    capabilityId: 'understand-environments',
    access: 'read',
    async handler(input): Promise<McpJsonObject> {
      try {
        const source = input.source as McpJsonObject;
        let content: string;
        if (source.mode === 'repository') {
          const repository = await findRepository(source.repository as string);
          if (!repository) {
            throw new McpExecutionError(
              'repo_not_onboarded',
              'That repository is not onboarded. Call list_repositories to see repositories you can use.'
            );
          }
          try {
            content = await fetchRepositoryContent(repository.fullName, source.branch as string);
          } catch {
            throw new McpExecutionError(
              'upstream_unavailable',
              'Lifecycle could not read lifecycle.yaml from GitHub. Retry this request later.'
            );
          }
        } else {
          content = source.content as string;
        }

        const result = await validateContent(content);
        return {
          valid: result.valid,
          errors: result.errors.slice(0, 50).map((issue) => ({
            path: safeCoreText(issue.path, 500) || '$',
            message: safeCoreText(issue.message, 500) || 'The configuration is invalid.',
          })),
        };
      } catch (error) {
        throw mapCoreToolError(error);
      }
    },
  };
}
