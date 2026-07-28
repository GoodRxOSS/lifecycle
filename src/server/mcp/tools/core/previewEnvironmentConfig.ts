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

import type { McpJsonObject, McpToolDefinition } from '../../contracts';
import { McpExecutionError } from '../../errors';
import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';
import ApiAccessConfigService from 'server/services/apiAccessConfig';
import BuildService from 'server/services/build';
import { defaultFindRepository, mapCoreToolError, safeCoreText, type CoreRepositoryRecord } from './listRepositories';

const DESCRIPTION =
  'Shows what an environment created from this repository and branch would contain: each service, whether it deploys by default, and whether you can override it. Run this before create_environment when you plan to override services, and after any create that failed with a configuration error.';

const SERVICE_TYPES = [
  'docker',
  'github',
  'externalHTTP',
  'aurora-restore',
  'codefresh',
  'configuration',
  'helm',
] as const;

const PREVIEW_STATUSES = ['resolved', 'unresolved', 'invalid', 'rate_limited', 'truncated'] as const;

export interface EnvironmentConfigPreviewServiceRecord {
  name: string;
  type: string | null;
  defaultActive: boolean;
  editable: boolean;
  repository?: string | null;
  effectiveBranch?: string | null;
  status?: string;
  reason?: string;
  previewOnly?: boolean;
}

export interface EnvironmentConfigPreviewRecord {
  valid: boolean;
  error?: string;
  services: EnvironmentConfigPreviewServiceRecord[];
  unresolved?: Array<{ name: string; status: string; reason: string }>;
  truncated?: boolean;
}

export interface PreviewEnvironmentConfigToolDependencies {
  findRepository?: (fullName: string) => Promise<CoreRepositoryRecord | null>;
  previewEnvironmentConfig?: (repository: string, branch: string) => Promise<EnvironmentConfigPreviewRecord>;
  loadEnvironmentPolicy?: () => Promise<{ defaultTtlHours: number; maxTtlHours: number }>;
}

export const previewEnvironmentConfigInputSchema = closedObjectSchema(
  {
    repository: {
      type: 'string',
      maxLength: 140,
      pattern: '^[^/]+/[^/]+$',
    },
    branch: { type: 'string', minLength: 1, maxLength: 255 },
  },
  ['repository', 'branch']
);

const previewServiceSchema = closedObjectSchema(
  {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    type: { type: 'string', enum: SERVICE_TYPES },
    defaultActive: { type: 'boolean' },
    editable: { type: 'boolean' },
    repository: { type: 'string', maxLength: 140, pattern: '^[^/]+/[^/]+$' },
    effectiveBranch: { type: 'string', minLength: 1, maxLength: 255 },
    status: { type: 'string', enum: PREVIEW_STATUSES },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    previewOnly: { type: 'boolean' },
  },
  ['name', 'type', 'defaultActive', 'editable', 'status', 'previewOnly']
);

export const previewEnvironmentConfigOutputSchema = successObjectSchema(
  {
    valid: { type: 'boolean' },
    validationMessage: { type: 'string', minLength: 1, maxLength: 1000 },
    services: {
      type: 'array',
      minItems: 0,
      maxItems: 201,
      items: previewServiceSchema,
    },
    unresolved: {
      type: 'array',
      minItems: 0,
      maxItems: 201,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
    truncated: { type: 'boolean' },
    policy: closedObjectSchema(
      {
        defaultTtlHours: { type: 'integer', minimum: 1, maximum: 8760 },
        maxTtlHours: { type: 'integer', minimum: 1, maximum: 8760 },
      },
      ['defaultTtlHours', 'maxTtlHours']
    ),
  },
  ['valid', 'services', 'unresolved', 'truncated', 'policy']
);

function safePreviewService(service: EnvironmentConfigPreviewServiceRecord): McpJsonObject | null {
  const type = SERVICE_TYPES.find((candidate) => candidate === service.type);
  // Invalid configs may reference a service with no resolvable type; its name stays in `unresolved`.
  if (!type) return null;
  const status = PREVIEW_STATUSES.find((candidate) => candidate === service.status) ?? 'resolved';
  const repository = service.repository ? safeCoreText(service.repository, 140) : undefined;
  const effectiveBranch = service.effectiveBranch ? safeCoreText(service.effectiveBranch, 255) : undefined;
  const reason = service.reason ? safeCoreText(service.reason, 1000) : undefined;
  return {
    name: safeCoreText(service.name, 100),
    type,
    defaultActive: service.defaultActive === true,
    editable: service.editable === true,
    ...(repository ? { repository } : {}),
    ...(effectiveBranch ? { effectiveBranch } : {}),
    status,
    ...(reason ? { reason } : {}),
    previewOnly: service.previewOnly === true,
  };
}

export function createPreviewEnvironmentConfigToolDefinition(
  dependencies: PreviewEnvironmentConfigToolDependencies = {}
): McpToolDefinition {
  let defaultBuildService: BuildService | undefined;
  const buildService = () => (defaultBuildService ??= new BuildService());
  const findRepository = dependencies.findRepository ?? defaultFindRepository;
  const previewEnvironmentConfig =
    dependencies.previewEnvironmentConfig ??
    ((repository: string, branch: string) => buildService().previewEnvironmentConfig(repository, branch));
  const loadEnvironmentPolicy =
    dependencies.loadEnvironmentPolicy ??
    (async () => {
      const policy = await ApiAccessConfigService.getInstance().getApiEnvironmentsConfig();
      return {
        defaultTtlHours: policy.defaultTtlHours,
        maxTtlHours: policy.maxTtlHours,
      };
    });

  return {
    name: 'preview_environment_config',
    title: 'Preview environment config',
    description: DESCRIPTION,
    inputSchema: previewEnvironmentConfigInputSchema,
    outputSchema: previewEnvironmentConfigOutputSchema,
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
        const requestedRepository = input.repository as string;
        const repository = await findRepository(requestedRepository);
        if (!repository) {
          throw new McpExecutionError(
            'repo_not_onboarded',
            'That repository is not onboarded. Call list_repositories to see repositories you can use.'
          );
        }
        const [preview, policy] = await Promise.all([
          previewEnvironmentConfig(repository.fullName, input.branch as string),
          loadEnvironmentPolicy(),
        ]);
        if (!preview.valid && preview.error) {
          throw new McpExecutionError(
            'config_invalid',
            safeCoreText(preview.error, 1000) ||
              'Lifecycle could not read lifecycle.yaml from that repository and branch.'
          );
        }

        const services = preview.services
          .slice(0, 201)
          .map(safePreviewService)
          .filter((service): service is McpJsonObject => service !== null);
        const unresolved = [
          ...new Set(
            [
              ...(preview.unresolved ?? []).map((entry) => entry.name),
              ...preview.services
                .filter(
                  (service) =>
                    !SERVICE_TYPES.includes(service.type as (typeof SERVICE_TYPES)[number]) ||
                    (service.status && service.status !== 'resolved')
                )
                .map((service) => service.name),
            ]
              .map((name) => safeCoreText(name, 100))
              .filter(Boolean)
          ),
        ].slice(0, 201);
        return {
          valid: preview.valid,
          ...(!preview.valid
            ? {
                validationMessage:
                  safeCoreText(preview.error ?? 'lifecycle.yaml did not pass validation.', 1000) ||
                  'lifecycle.yaml did not pass validation.',
              }
            : {}),
          services,
          unresolved,
          truncated: preview.truncated === true || preview.services.length > 201,
          policy,
        };
      } catch (error) {
        throw mapCoreToolError(error);
      }
    },
  };
}
