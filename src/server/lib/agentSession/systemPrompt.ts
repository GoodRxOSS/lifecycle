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

import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { fetchLifecycleConfig, getDeployingServicesByName } from 'server/models/yaml';
import type { LifecycleConfig } from 'server/models/yaml';

export interface AgentSessionPromptServiceContext {
  name: string;
  publicUrl?: string;
  workDir?: string;
}

export interface AgentSessionPromptContext {
  namespace: string;
  buildUuid?: string | null;
  services: AgentSessionPromptServiceContext[];
}

type SessionPromptLookupContext = {
  sessionDbId: number;
  namespace: string;
  buildUuid?: string | null;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatPublicUrl(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  return /^https?:\/\//.test(normalized) ? normalized : `https://${normalized}`;
}

export function buildAgentSessionDynamicSystemPrompt(context: AgentSessionPromptContext): string {
  const lines = ['Session context:', `- namespace: ${context.namespace}`];

  if (context.buildUuid) {
    lines.push(`- buildUuid: ${context.buildUuid}`);
  }

  if (context.services.length > 0) {
    lines.push('- selected services:');

    const services = [...context.services].sort((left, right) => left.name.localeCompare(right.name));
    for (const service of services) {
      const details = [
        service.publicUrl ? `publicUrl=${service.publicUrl}` : null,
        service.workDir ? `workDir=${service.workDir}` : null,
      ].filter((value): value is string => Boolean(value));

      lines.push(`  - ${service.name}${details.length > 0 ? `: ${details.join(', ')}` : ''}`);
    }
  }

  return lines.join('\n');
}

export function combineAgentSessionAppendSystemPrompt(
  configuredPrompt?: string,
  dynamicPrompt?: string
): string | undefined {
  const parts = [normalizeOptionalString(configuredPrompt), normalizeOptionalString(dynamicPrompt)].filter(
    (value): value is string => Boolean(value)
  );

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

async function fetchCachedLifecycleConfig(
  repositoryName: string,
  branchName: string,
  cache: Map<string, Promise<LifecycleConfig | null>>
): Promise<LifecycleConfig | null> {
  const key = `${repositoryName}::${branchName}`;
  let promise = cache.get(key);

  if (!promise) {
    promise = fetchLifecycleConfig(repositoryName, branchName).catch(() => null);
    cache.set(key, promise);
  }

  return promise;
}

async function resolveBuildSource(buildUuid?: string | null): Promise<{ repo?: string; branch?: string }> {
  const normalizedBuildUuid = normalizeOptionalString(buildUuid);
  if (!normalizedBuildUuid) {
    return {};
  }

  const build = await Build.query().findOne({ uuid: normalizedBuildUuid }).withGraphFetched('[pullRequest]');
  return {
    repo: normalizeOptionalString(build?.pullRequest?.fullName),
    branch: normalizeOptionalString(build?.pullRequest?.branchName),
  };
}

export async function resolveAgentSessionPromptContext(
  lookup: SessionPromptLookupContext
): Promise<AgentSessionPromptContext> {
  const deploys = await Deploy.query()
    .where({ devModeSessionId: lookup.sessionDbId })
    .withGraphFetched('[deployable, repository, service]');
  const buildSource = await resolveBuildSource(lookup.buildUuid);
  const lifecycleConfigCache = new Map<string, Promise<LifecycleConfig | null>>();

  const services = await Promise.all(
    deploys.map(async (deploy): Promise<AgentSessionPromptServiceContext | null> => {
      const serviceName =
        normalizeOptionalString(deploy.deployable?.name) ||
        normalizeOptionalString(deploy.service?.name) ||
        normalizeOptionalString(deploy.uuid);

      if (!serviceName) {
        return null;
      }

      const repositoryName = normalizeOptionalString(deploy.repository?.fullName) || buildSource.repo;
      const branchName = normalizeOptionalString(deploy.branchName) || buildSource.branch;

      let workDir: string | undefined;
      if (repositoryName && branchName) {
        const lifecycleConfig = await fetchCachedLifecycleConfig(repositoryName, branchName, lifecycleConfigCache);
        const yamlService = lifecycleConfig ? getDeployingServicesByName(lifecycleConfig, serviceName) : undefined;
        workDir = normalizeOptionalString(yamlService?.dev?.workDir);
      }

      return {
        name: serviceName,
        publicUrl: formatPublicUrl(deploy.publicUrl),
        workDir,
      };
    })
  );

  return {
    namespace: lookup.namespace,
    buildUuid: lookup.buildUuid,
    services: services.filter((service): service is AgentSessionPromptServiceContext => Boolean(service)),
  };
}
