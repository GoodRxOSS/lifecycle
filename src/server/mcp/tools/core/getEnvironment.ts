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

import type Build from 'server/models/Build';
import Repository from 'server/models/Repository';
import BuildService from 'server/services/build';
import { BuildKind } from 'shared/constants';
import { toMcpEnvironmentDto, type McpEnvironmentFormat } from './environmentDto';
import type { McpJsonObject, McpToolDefinition } from '../../contracts';
import { normalizeMcpDateTime, type McpDateTimeInput } from '../../dateTime';
import { McpExecutionError } from '../../errors';
import { BUILD_STATUSES, ENVIRONMENT_PHASES } from '../statusValues';
import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';
import { lifecycleUiUrlSchema } from './environmentUrl';
import { mapCoreToolError, safeCoreText } from './listRepositories';

const DESCRIPTION =
  'Full state of one environment: its status, each service, and the URLs to open. Show `lifecycleUiUrl` to the user so they can follow deployment status in Lifecycle. The response includes the environmentId required for changes and waits. Every service that exposes a public address shows it as `url`; services without one have no `url`. `format: "detailed"` adds images, commit ids, and dependency info.';

const MAX_ENVIRONMENT_SERVICES = 100;
const MAX_ENVIRONMENT_RESPONSE_BYTES = 90_000;

export interface EnvironmentRepositoryAnchor {
  githubRepositoryId: number | null;
  fullName: string;
}

export interface LoadedEnvironment {
  build: Build;
  repository: EnvironmentRepositoryAnchor;
}

export interface DestroyedEnvironmentEvidence {
  destroyedAt: McpDateTimeInput;
}

export interface GetEnvironmentToolDependencies {
  loadEnvironment?: (uuid: string) => Promise<LoadedEnvironment | null>;
  loadDestroyedEnvironment?: (uuid: string) => Promise<DestroyedEnvironmentEvidence | null>;
}

export type NamedEnvironmentReadDependencies = Required<
  Pick<GetEnvironmentToolDependencies, 'loadEnvironment' | 'loadDestroyedEnvironment'>
>;

export function isEnvironmentBuild(build: Build | null | undefined): build is Build {
  return build?.kind === BuildKind.ENVIRONMENT;
}

export const getEnvironmentInputSchema = closedObjectSchema(
  {
    uuid: { type: 'string', minLength: 1, maxLength: 63 },
    format: {
      type: 'string',
      enum: ['concise', 'detailed'],
      default: 'concise',
    },
  },
  ['uuid']
);

const conciseServiceProperties = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  type: { type: 'string', minLength: 1, maxLength: 100 },
  status: { type: 'string', minLength: 1, maxLength: 100 },
  active: { type: 'boolean' },
  url: { type: 'string', format: 'uri', minLength: 1, maxLength: 2000 },
  branch: { type: 'string', maxLength: 255 },
};

const conciseServiceSchema = closedObjectSchema(conciseServiceProperties, ['name', 'type', 'status', 'active']);

const detailedServiceSchema = closedObjectSchema(
  {
    ...conciseServiceProperties,
    statusMessage: { type: 'string', minLength: 1, maxLength: 1000 },
    sha: { type: 'string', minLength: 1, maxLength: 255 },
    dockerImage: { type: 'string', minLength: 1, maxLength: 1000 },
    dependsOn: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
  ['name', 'type', 'status', 'active']
);

function environmentProperties(
  format: McpEnvironmentFormat,
  serviceSchema: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  return {
    format: { type: 'string', const: format },
    uuid: { type: 'string', minLength: 1, maxLength: 63 },
    environmentId: { type: 'integer', minimum: 1 },
    lifecycleUiUrl: lifecycleUiUrlSchema,
    status: { type: 'string', enum: BUILD_STATUSES },
    phase: { type: 'string', enum: ENVIRONMENT_PHASES },
    statusMessage: { type: 'string', minLength: 1, maxLength: 1000 },
    repository: { type: 'string', maxLength: 140, pattern: '^[^/]+/[^/]+$' },
    branch: { type: 'string', maxLength: 255 },
    trigger: { type: 'string', enum: ['api', 'github_pr'] },
    isStatic: { type: 'boolean' },
    deployEnabled: { type: 'boolean' },
    autoTrack: { type: 'boolean' },
    expiresAt: { type: 'string', format: 'date-time' },
    ready: { type: 'boolean' },
    currentDeployId: { type: 'string', minLength: 1, maxLength: 100 },
    services: {
      type: 'array',
      minItems: 0,
      maxItems: MAX_ENVIRONMENT_SERVICES,
      items: serviceSchema,
    },
    servicesTruncated: { type: 'boolean' },
    failingServices: {
      type: 'array',
      minItems: 0,
      maxItems: MAX_ENVIRONMENT_SERVICES,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
    note: { type: 'string', minLength: 1, maxLength: 1000 },
  };
}

const baseEnvironmentRequired = [
  'format',
  'uuid',
  'environmentId',
  'status',
  'phase',
  'repository',
  'branch',
  'trigger',
  'isStatic',
  'deployEnabled',
  'autoTrack',
  'ready',
  'services',
  'servicesTruncated',
  'failingServices',
];

export const conciseEnvironmentSchema = closedObjectSchema(
  environmentProperties('concise', conciseServiceSchema),
  baseEnvironmentRequired
);

export const detailedEnvironmentSchema = closedObjectSchema(
  {
    ...environmentProperties('detailed', detailedServiceSchema),
    configSha: { type: 'string', minLength: 1, maxLength: 255 },
    trackDefaultBranches: { type: 'boolean' },
    namespace: { type: 'string', minLength: 1, maxLength: 253 },
    createdBy: { type: 'string', minLength: 1, maxLength: 255 },
    envKeys: {
      type: 'array',
      minItems: 0,
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 255 },
    },
    initEnvKeys: {
      type: 'array',
      minItems: 0,
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 255 },
    },
  },
  [...baseEnvironmentRequired, 'trackDefaultBranches', 'namespace', 'envKeys', 'initEnvKeys']
);

export const getEnvironmentOutputSchema = successObjectSchema(
  {
    environment: { oneOf: [conciseEnvironmentSchema, detailedEnvironmentSchema] },
  },
  ['environment']
);

function validUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeEnvironmentServices(value: unknown): McpJsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ENVIRONMENT_SERVICES).map((raw) => {
    const service = raw as Record<string, unknown>;
    const url = validUrl(service.url);
    return {
      name: safeCoreText(service.name, 100),
      type: safeCoreText(service.type, 100) || 'unknown',
      status: safeCoreText(service.status, 100) || 'unknown',
      active: service.active === true,
      ...(url ? { url } : {}),
      ...(typeof service.branch === 'string' ? { branch: safeCoreText(service.branch, 255) } : {}),
      ...(typeof service.statusMessage === 'string' && service.statusMessage
        ? { statusMessage: safeCoreText(service.statusMessage, 1000) }
        : {}),
      ...(typeof service.sha === 'string' && service.sha ? { sha: safeCoreText(service.sha, 255) } : {}),
      ...(typeof service.dockerImage === 'string' && service.dockerImage
        ? { dockerImage: safeCoreText(service.dockerImage, 1000) }
        : {}),
      ...(Array.isArray(service.dependsOn) && service.dependsOn.length > 0
        ? {
            dependsOn: [...new Set(service.dependsOn.map((name) => safeCoreText(name, 100)).filter(Boolean))]
              .sort()
              .slice(0, 100),
          }
        : {}),
    };
  });
}

function namedServiceCount(build: Build): number {
  return (build.deploys ?? []).filter((deploy) => Boolean(safeCoreText(deploy.deployable?.name, 100))).length;
}

export function serializeEnvironmentState(
  loaded: LoadedEnvironment,
  options: {
    format?: McpEnvironmentFormat;
  } = {}
): McpJsonObject {
  const { build, repository } = loaded;
  const format = options.format ?? 'concise';
  const source = toMcpEnvironmentDto(build, {
    repository: repository.fullName,
    format,
    maxServices: MAX_ENVIRONMENT_SERVICES,
  }) as unknown as Record<string, unknown>;
  const services = safeEnvironmentServices(source.services);
  const totalServices = namedServiceCount(build);
  const failingServices = Array.isArray(source.failingServices)
    ? [...new Set(source.failingServices.map((name) => safeCoreText(name, 100)).filter(Boolean))]
        .sort()
        .slice(0, MAX_ENVIRONMENT_SERVICES)
    : [];

  const environment: McpJsonObject = {
    ...(source as unknown as McpJsonObject),
    environmentId: Number(build.id),
    repository: safeCoreText(repository.fullName, 140),
    services,
    servicesTruncated: source.servicesTruncated === true || totalServices > services.length,
    failingServices,
  };
  if (format === 'detailed') {
    environment.trackDefaultBranches = source.trackDefaultBranches === true;
    environment.namespace = safeCoreText(source.namespace, 253);
    environment.envKeys = Array.isArray(source.envKeys) ? source.envKeys.slice(0, 100) : [];
    environment.initEnvKeys = Array.isArray(source.initEnvKeys) ? source.initEnvKeys.slice(0, 100) : [];
  }

  let removedForBytes = 0;
  while (
    Buffer.byteLength(JSON.stringify(environment), 'utf8') > MAX_ENVIRONMENT_RESPONSE_BYTES &&
    (environment.services as McpJsonObject[]).length > 0
  ) {
    (environment.services as McpJsonObject[]).pop();
    removedForBytes += 1;
    environment.servicesTruncated = true;
  }
  const omittedServices = totalServices - (environment.services as McpJsonObject[]).length;
  const notes: string[] = [];
  if (omittedServices > 0) {
    notes.push(`${omittedServices} service${omittedServices === 1 ? '' : 's'} omitted to keep the response bounded.`);
  } else if (removedForBytes > 0) {
    notes.push('Some services were omitted to keep the response bounded.');
  }
  if (notes.length > 0) environment.note = notes.join(' ');
  return environment;
}

async function resolveRepositoryForBuild(build: Build): Promise<EnvironmentRepositoryAnchor> {
  let repository: Repository | undefined;
  if (build.githubRepositoryId != null) {
    repository = await Repository.query()
      .findOne({ githubRepositoryId: Number(build.githubRepositoryId) })
      .whereNull('deletedAt');
  } else if (build.pullRequest?.fullName) {
    repository = await Repository.query()
      .whereRaw('lower("fullName") = ?', [build.pullRequest.fullName.toLowerCase()])
      .whereNull('deletedAt')
      .first();
  }
  const fullName = repository?.fullName ?? build.pullRequest?.fullName ?? '';
  return {
    githubRepositoryId:
      repository?.githubRepositoryId == null
        ? build.githubRepositoryId == null
          ? null
          : Number(build.githubRepositoryId)
        : Number(repository.githubRepositoryId),
    fullName,
  };
}

export function resolveNamedEnvironmentReadDependencies(
  dependencies: GetEnvironmentToolDependencies = {}
): NamedEnvironmentReadDependencies {
  let defaultBuildService: BuildService | undefined;
  const buildService = () => (defaultBuildService ??= new BuildService());
  return {
    loadEnvironment:
      dependencies.loadEnvironment ??
      (async (uuid: string): Promise<LoadedEnvironment | null> => {
        const build = await buildService().getBuildByUUID(uuid, { liveOnly: true });
        if (!isEnvironmentBuild(build)) return null;
        return { build, repository: await resolveRepositoryForBuild(build) };
      }),
    loadDestroyedEnvironment:
      dependencies.loadDestroyedEnvironment ??
      (async (uuid: string) => {
        const build = await buildService().getBuildByUUID(uuid, { liveOnly: false });
        if (!isEnvironmentBuild(build) || !build.deletedAt) return null;
        const destroyedAt = normalizeMcpDateTime(build.deletedAt);
        if (!destroyedAt) {
          throw new McpExecutionError(
            'internal_error',
            'Lifecycle could not verify when this environment was destroyed. Ask an administrator for help.'
          );
        }
        return {
          destroyedAt,
        };
      }),
  };
}

/** Any authenticated user may resolve any environment by name, matching the web UI. */
export async function resolveNamedEnvironmentRead(
  uuid: string,
  dependencies: NamedEnvironmentReadDependencies = resolveNamedEnvironmentReadDependencies()
): Promise<LoadedEnvironment> {
  const loaded = await dependencies.loadEnvironment(uuid);
  if (loaded && isEnvironmentBuild(loaded.build)) return loaded;

  const destroyed = await dependencies.loadDestroyedEnvironment(uuid);
  if (destroyed) {
    const destroyedAt = normalizeMcpDateTime(destroyed.destroyedAt);
    if (!destroyedAt) {
      throw new McpExecutionError(
        'internal_error',
        'Lifecycle could not verify when this environment was destroyed. Ask an administrator for help.'
      );
    }
    throw new McpExecutionError('env_not_found', 'That environment was destroyed.', {
      details: {
        kind: 'destroyed',
        destroyedAt,
      },
    });
  }
  throw new McpExecutionError('env_not_found', 'That environment was not found.');
}

export function createGetEnvironmentToolDefinition(
  dependencies: GetEnvironmentToolDependencies = {}
): McpToolDefinition {
  const readDependencies = resolveNamedEnvironmentReadDependencies(dependencies);

  return {
    name: 'get_environment',
    title: 'Get environment',
    description: DESCRIPTION,
    inputSchema: getEnvironmentInputSchema,
    outputSchema: getEnvironmentOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'understand-environments',
    access: 'read',
    async handler(input): Promise<McpJsonObject> {
      try {
        const uuid = input.uuid as string;
        const loaded = await resolveNamedEnvironmentRead(uuid, readDependencies);
        const environment = serializeEnvironmentState(loaded, {
          format: input.format === 'detailed' ? 'detailed' : 'concise',
        });
        return { environment };
      } catch (error) {
        throw mapCoreToolError(error);
      }
    },
  };
}
