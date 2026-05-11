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

import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { fetchLifecycleConfig, getDeployingServicesByName } from 'server/models/yaml';
import type { LifecycleConfig } from 'server/models/yaml';
import GlobalConfigService from 'server/services/globalConfig';

export interface AgentSessionPromptServiceContext {
  name: string;
  active?: boolean;
  status?: string;
  statusMessage?: string;
  publicUrl?: string;
  repo?: string;
  branch?: string;
  deployUuid?: string;
  serviceSha?: string;
  dockerfilePath?: string;
  initDockerfilePath?: string;
  deployableType?: string;
  source?: string;
  chartName?: string;
  chartRepoUrl?: string;
  chartValueFiles?: string[];
  dockerImage?: string;
  buildPipelineId?: string;
  deployPipelineId?: string;
  workspacePath?: string;
  workDir?: string;
}

export interface AgentSessionPromptBuildContext {
  uuid: string;
  status?: string;
  statusMessage?: string;
  namespace?: string;
  sha?: string;
}

export interface AgentSessionPromptPullRequestContext {
  fullName?: string;
  branchName?: string;
  pullRequestNumber?: number;
  url?: string;
  status?: string;
  labels?: string[];
  deployOnUpdate?: boolean;
  deployLabels?: string[];
  disabledLabels?: string[];
  latestCommit?: string;
  repositoryUrl?: string;
}

export interface AgentSessionPromptContext {
  namespace?: string | null;
  buildUuid?: string | null;
  gatheredAt?: string;
  build?: AgentSessionPromptBuildContext;
  pullRequest?: AgentSessionPromptPullRequestContext;
  services: AgentSessionPromptServiceContext[];
  selectedDeploy?: AgentSessionPromptServiceContext;
  diagnosticServices?: AgentSessionPromptServiceContext[];
  skillsAvailable?: boolean;
  toolLines?: string[];
}

type SessionPromptLookupContext = {
  sessionDbId: number;
  namespace?: string | null;
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

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item));

  return normalized.length ? normalized : undefined;
}

function normalizeStringArraySnapshot(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item));
}

function formatDetails(details: Array<string | undefined>): string {
  return details.filter((value): value is string => Boolean(value)).join(', ');
}

function formatOptionalString(value: string | undefined): string {
  return value || '<none>';
}

function formatOptionalStringArray(value: string[] | undefined): string {
  if (!value) {
    return '<unknown>';
  }

  return value.length > 0 ? value.join('|') : '<none>';
}

function formatOptionalBoolean(value: boolean | undefined): string {
  return value === undefined ? '<unknown>' : String(value);
}

export function buildAgentSessionDynamicSystemPrompt(context: AgentSessionPromptContext): string {
  const lines = ['Initial Lifecycle snapshot:'];

  if (context.namespace) {
    lines.push(`- namespace: ${context.namespace}`);
  }

  if (context.buildUuid) {
    lines.push(`- buildUuid: ${context.buildUuid}`);
  }

  if (context.gatheredAt) {
    lines.push(`- observedAt: ${context.gatheredAt}`, '- source: lifecycle_db');
  }

  if (context.build) {
    const details = formatDetails([
      context.build.status ? `buildStatusAtStart=${context.build.status}` : undefined,
      `buildStatusMessageAtStart=${formatOptionalString(context.build.statusMessage)}`,
      context.build.namespace ? `namespace=${context.build.namespace}` : undefined,
      context.build.sha ? `sha=${context.build.sha}` : undefined,
    ]);
    lines.push(`- build=${context.build.uuid}${details ? `: ${details}` : ''}`);
  }

  if (context.pullRequest) {
    const pr = context.pullRequest;
    const details = formatDetails([
      pr.fullName ? `repo=${pr.fullName}` : undefined,
      pr.branchName ? `branch=${pr.branchName}` : undefined,
      pr.pullRequestNumber != null ? `number=${pr.pullRequestNumber}` : undefined,
      pr.url ? `url=${pr.url}` : undefined,
      pr.status ? `statusAtStart=${pr.status}` : undefined,
      `labelsAtStart=${formatOptionalStringArray(pr.labels)}`,
      `deployOnUpdateAtStart=${formatOptionalBoolean(pr.deployOnUpdate)}`,
      `deployLabels=${formatOptionalStringArray(pr.deployLabels)}`,
      `disabledLabels=${formatOptionalStringArray(pr.disabledLabels)}`,
      pr.latestCommit ? `latestCommit=${pr.latestCommit}` : undefined,
      pr.repositoryUrl ? `repositoryUrl=${pr.repositoryUrl}` : undefined,
    ]);

    if (details) {
      lines.push('Pull request:', `- ${details}`);
    }
  }

  if (!context.selectedDeploy && context.services.length > 0) {
    lines.push('Selected services:');

    const services = [...context.services].sort((left, right) => left.name.localeCompare(right.name));
    for (const service of services) {
      const details = [
        service.deployUuid ? `deployUuid=${service.deployUuid}` : null,
        service.active !== undefined ? `activeAtStart=${service.active}` : null,
        service.status ? `statusAtStart=${service.status}` : null,
        service.statusMessage ? `statusMessageAtStart=${service.statusMessage}` : null,
        service.repo ? `repo=${service.repo}` : null,
        service.branch ? `branch=${service.branch}` : null,
        service.serviceSha ? `serviceSha=${service.serviceSha}` : null,
        service.dockerfilePath ? `dockerfilePath=${service.dockerfilePath}` : null,
        service.initDockerfilePath ? `initDockerfilePath=${service.initDockerfilePath}` : null,
        service.deployableType ? `type=${service.deployableType}` : null,
        service.source ? `source=${service.source}` : null,
        service.publicUrl ? `publicUrl=${service.publicUrl}` : null,
        service.workspacePath ? `workspacePath=${service.workspacePath}` : null,
        service.workDir ? `workDir=${service.workDir}` : null,
      ].filter((value): value is string => Boolean(value));

      lines.push(`- ${service.name}${details.length > 0 ? `: ${details.join(', ')}` : ''}`);
    }
  }

  if (context.selectedDeploy) {
    const service = context.selectedDeploy;
    const details = formatDetails([
      service.deployUuid ? `deployUuid=${service.deployUuid}` : undefined,
      service.active !== undefined ? `activeAtStart=${service.active}` : undefined,
      service.status ? `statusAtStart=${service.status}` : undefined,
      `statusMessageAtStart=${formatOptionalString(service.statusMessage)}`,
      service.repo ? `repo=${service.repo}` : undefined,
      service.branch ? `branch=${service.branch}` : undefined,
      service.serviceSha ? `serviceSha=${service.serviceSha}` : undefined,
      service.dockerfilePath ? `dockerfilePath=${service.dockerfilePath}` : undefined,
      service.initDockerfilePath ? `initDockerfilePath=${service.initDockerfilePath}` : undefined,
      service.deployableType ? `type=${service.deployableType}` : undefined,
      service.source ? `source=${service.source}` : undefined,
      service.chartName ? `chartName=${service.chartName}` : undefined,
      service.chartRepoUrl ? `chartRepoUrl=${service.chartRepoUrl}` : undefined,
      service.chartValueFiles?.length ? `chartValueFiles=${service.chartValueFiles.join('|')}` : undefined,
      service.publicUrl ? `publicUrl=${service.publicUrl}` : undefined,
      service.dockerImage ? `dockerImage=${service.dockerImage}` : undefined,
      service.buildPipelineId ? `buildPipelineId=${service.buildPipelineId}` : undefined,
      service.deployPipelineId ? `deployPipelineId=${service.deployPipelineId}` : undefined,
    ]);

    lines.push('Selected deploy:', `- ${service.name}${details ? `: ${details}` : ''}`);
  }

  if (context.diagnosticServices?.length) {
    lines.push('Deploy roster:');

    const diagnosticServices = [...context.diagnosticServices].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const service of diagnosticServices) {
      const details = formatDetails([
        service.deployUuid ? `deployUuid=${service.deployUuid}` : undefined,
        service.active !== undefined ? `activeAtStart=${service.active}` : undefined,
        service.status ? `statusAtStart=${service.status}` : undefined,
        `statusMessageAtStart=${formatOptionalString(service.statusMessage)}`,
        service.repo ? `repo=${service.repo}` : undefined,
        service.branch ? `branch=${service.branch}` : undefined,
        service.publicUrl ? `publicUrl=${service.publicUrl}` : undefined,
        service.dockerImage ? `dockerImage=${service.dockerImage}` : undefined,
        service.buildPipelineId ? `buildPipelineId=${service.buildPipelineId}` : undefined,
        service.deployPipelineId ? `deployPipelineId=${service.deployPipelineId}` : undefined,
      ]);

      lines.push(`- ${service.name}${details ? `: ${details}` : ''}`);
    }
  }

  if (context.skillsAvailable) {
    lines.push('- equipped skills: use skills.list to discover them and skills.learn to load a skill before using it');
  }

  if (context.toolLines?.length) {
    lines.push('- equipped tools:');
    lines.push(...context.toolLines.map((line) => `  ${line}`));
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

type BuildDiagnosticContext = {
  source: { repo?: string; branch?: string };
  build?: AgentSessionPromptBuildContext;
  pullRequest?: AgentSessionPromptPullRequestContext;
  deploys: Deploy[];
  diagnosticServices: AgentSessionPromptServiceContext[];
};

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

function buildPullRequestUrl(fullName?: string, pullRequestNumber?: number): string | undefined {
  if (!fullName || pullRequestNumber == null) {
    return undefined;
  }

  return `https://github.com/${fullName}/pull/${pullRequestNumber}`;
}

function formatDeployDiagnosticService(
  deploy: Deploy,
  buildSource: { repo?: string; branch?: string }
): AgentSessionPromptServiceContext | null {
  const name =
    normalizeOptionalString(deploy.deployable?.name) ||
    normalizeOptionalString(deploy.service?.name) ||
    normalizeOptionalString(deploy.uuid);

  if (!name) {
    return null;
  }

  return {
    name,
    active: typeof deploy.active === 'boolean' ? deploy.active : undefined,
    deployUuid: normalizeOptionalString(deploy.uuid),
    status: normalizeOptionalString(deploy.status),
    statusMessage: normalizeOptionalString(deploy.statusMessage),
    publicUrl: formatPublicUrl(deploy.publicUrl),
    repo: normalizeOptionalString(deploy.repository?.fullName) || buildSource.repo,
    branch: normalizeOptionalString(deploy.branchName) || buildSource.branch,
    dockerImage: normalizeOptionalString(deploy.dockerImage),
    buildPipelineId: normalizeOptionalString(deploy.buildPipelineId),
    deployPipelineId: normalizeOptionalString(deploy.deployPipelineId),
  };
}

async function resolveBuildDiagnosticContext(buildUuid?: string | null): Promise<BuildDiagnosticContext> {
  const normalizedBuildUuid = normalizeOptionalString(buildUuid);
  if (!normalizedBuildUuid) {
    return { source: {}, deploys: [], diagnosticServices: [] };
  }

  const build = await Build.query()
    .findOne({ uuid: normalizedBuildUuid })
    .withGraphFetched('[pullRequest.[repository], deploys.[deployable, repository, service]]');
  const labelsConfig = await GlobalConfigService.getInstance()
    .getLabels()
    .catch(() => undefined);
  const pullRequest = build?.pullRequest;
  const pullRequestNumber = pullRequest?.pullRequestNumber;
  const source = {
    repo: normalizeOptionalString(pullRequest?.fullName),
    branch: normalizeOptionalString(pullRequest?.branchName),
  };

  return {
    source,
    build: build
      ? {
          uuid: build.uuid,
          status: normalizeOptionalString(build.status),
          statusMessage: normalizeOptionalString(build.statusMessage),
          namespace: normalizeOptionalString(build.namespace),
          sha: normalizeOptionalString(build.sha),
        }
      : undefined,
    pullRequest: pullRequest
      ? {
          fullName: source.repo,
          branchName: source.branch,
          pullRequestNumber,
          url: buildPullRequestUrl(source.repo, pullRequestNumber),
          status: normalizeOptionalString(pullRequest.status),
          labels: normalizeStringArraySnapshot(pullRequest.labels),
          deployOnUpdate: typeof pullRequest.deployOnUpdate === 'boolean' ? pullRequest.deployOnUpdate : undefined,
          deployLabels: normalizeStringArraySnapshot(labelsConfig?.deploy),
          disabledLabels: normalizeStringArraySnapshot(labelsConfig?.disabled),
          latestCommit: normalizeOptionalString(pullRequest.latestCommit),
          repositoryUrl: normalizeOptionalString(pullRequest.repository?.htmlUrl),
        }
      : undefined,
    deploys: build?.deploys || [],
    diagnosticServices: (build?.deploys || [])
      .map((deploy) => formatDeployDiagnosticService(deploy, source))
      .filter((service): service is AgentSessionPromptServiceContext => Boolean(service)),
  };
}

export async function resolveAgentSessionPromptContext(
  lookup: SessionPromptLookupContext
): Promise<AgentSessionPromptContext> {
  const [session, deploys, buildSource] = await Promise.all([
    AgentSession.query().findById(lookup.sessionDbId),
    Deploy.query()
      .where({ devModeSessionId: lookup.sessionDbId })
      .withGraphFetched('[deployable, repository, service]'),
    resolveBuildDiagnosticContext(lookup.buildUuid),
  ]);
  const lifecycleConfigCache = new Map<string, Promise<LifecycleConfig | null>>();
  const allDeploys = deploys.length > 0 ? deploys : buildSource.deploys;
  const deployById = new Map(allDeploys.filter((deploy) => deploy.id != null).map((deploy) => [deploy.id, deploy]));

  let services: AgentSessionPromptServiceContext[];

  if (session?.selectedServices?.length) {
    services = session.selectedServices.map((service) => {
      const deploy = deployById.get(service.deployId);

      return {
        name: service.name,
        active: typeof deploy?.active === 'boolean' ? deploy.active : undefined,
        publicUrl: formatPublicUrl(deploy?.publicUrl),
        repo: normalizeOptionalString(service.repo),
        branch: normalizeOptionalString(service.branch),
        ...(normalizeOptionalString(service.deployUuid)
          ? { deployUuid: normalizeOptionalString(service.deployUuid) }
          : {}),
        ...(normalizeOptionalString(service.revision) ? { serviceSha: normalizeOptionalString(service.revision) } : {}),
        ...(normalizeOptionalString(service.dockerfilePath)
          ? { dockerfilePath: normalizeOptionalString(service.dockerfilePath) }
          : {}),
        ...(normalizeOptionalString(service.initDockerfilePath)
          ? { initDockerfilePath: normalizeOptionalString(service.initDockerfilePath) }
          : {}),
        ...(normalizeOptionalString(service.deployableType)
          ? { deployableType: normalizeOptionalString(service.deployableType) }
          : {}),
        ...(normalizeOptionalString(service.source) ? { source: normalizeOptionalString(service.source) } : {}),
        status: normalizeOptionalString(service.deployStatus),
        statusMessage: normalizeOptionalString(service.deployStatusMessage),
        dockerImage: normalizeOptionalString(service.dockerImage),
        buildPipelineId: normalizeOptionalString(service.buildPipelineId),
        deployPipelineId: normalizeOptionalString(service.deployPipelineId),
        ...(normalizeOptionalString(service.chartName)
          ? { chartName: normalizeOptionalString(service.chartName) }
          : {}),
        ...(normalizeOptionalString(service.chartRepoUrl)
          ? { chartRepoUrl: normalizeOptionalString(service.chartRepoUrl) }
          : {}),
        ...(normalizeStringArray(service.chartValueFiles)
          ? { chartValueFiles: normalizeStringArray(service.chartValueFiles) }
          : {}),
        workspacePath: normalizeOptionalString(service.workspacePath),
        workDir: normalizeOptionalString(service.workDir) || normalizeOptionalString(service.workspacePath),
      };
    });
  } else {
    services = (
      await Promise.all(
        allDeploys.map(async (deploy): Promise<AgentSessionPromptServiceContext | null> => {
          const serviceName =
            normalizeOptionalString(deploy.deployable?.name) ||
            normalizeOptionalString(deploy.service?.name) ||
            normalizeOptionalString(deploy.uuid);

          if (!serviceName) {
            return null;
          }

          const repositoryName = normalizeOptionalString(deploy.repository?.fullName) || buildSource.source.repo;
          const branchName = normalizeOptionalString(deploy.branchName) || buildSource.source.branch;

          let workDir: string | undefined;
          if (repositoryName && branchName) {
            const lifecycleConfig = await fetchCachedLifecycleConfig(repositoryName, branchName, lifecycleConfigCache);
            const yamlService = lifecycleConfig ? getDeployingServicesByName(lifecycleConfig, serviceName) : undefined;
            workDir = normalizeOptionalString(yamlService?.dev?.workDir);
          }

          return {
            name: serviceName,
            active: typeof deploy.active === 'boolean' ? deploy.active : undefined,
            deployUuid: normalizeOptionalString(deploy.uuid),
            status: normalizeOptionalString(deploy.status),
            statusMessage: normalizeOptionalString(deploy.statusMessage),
            publicUrl: formatPublicUrl(deploy.publicUrl),
            repo: repositoryName,
            branch: branchName,
            dockerImage: normalizeOptionalString(deploy.dockerImage),
            buildPipelineId: normalizeOptionalString(deploy.buildPipelineId),
            deployPipelineId: normalizeOptionalString(deploy.deployPipelineId),
            workDir,
          };
        })
      )
    ).filter((service): service is AgentSessionPromptServiceContext => Boolean(service));
  }

  return {
    namespace: lookup.namespace,
    buildUuid: lookup.buildUuid,
    gatheredAt: new Date().toISOString(),
    build: buildSource.build,
    pullRequest: buildSource.pullRequest,
    services,
    ...(services[0]?.deployUuid ? { selectedDeploy: services[0] } : {}),
    diagnosticServices: buildSource.diagnosticServices,
    skillsAvailable: Boolean(session?.skillPlan?.skills?.length),
  };
}
