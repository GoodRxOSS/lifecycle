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
import { buildTriageDossier } from './triageDossier';

export interface AgentSessionPromptServiceContext {
  name: string;
  active?: boolean;
  status?: string;
  statusMessage?: string;
  publicUrl?: string;
  repo?: string;
  branch?: string;
  dependsOn?: string[];
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

export interface AgentSessionPromptLifecycleConfigContext {
  status: 'present' | 'missing' | 'invalid';
  path: string;
  declaredServices?: string[];
}

export interface AgentSessionPromptContext {
  namespace?: string | null;
  buildUuid?: string | null;
  gatheredAt?: string;
  build?: AgentSessionPromptBuildContext;
  pullRequest?: AgentSessionPromptPullRequestContext;
  lifecycleConfig?: AgentSessionPromptLifecycleConfigContext;
  services: AgentSessionPromptServiceContext[];
  selectedDeploy?: AgentSessionPromptServiceContext;
  userSelectedServices?: boolean;
  diagnosticServices?: AgentSessionPromptServiceContext[];
  triage?: string;
}

type SessionPromptLookupContext = {
  sessionDbId: number;
  namespace?: string | null;
  buildUuid?: string | null;
  // Triage does live k8s I/O; callers that only need DB state (fingerprint checks) opt out.
  includeTriage?: boolean;
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

const STATUS_MESSAGE_MAX_CHARS = 400;

export function formatStatusMessage(value: string | undefined): string {
  if (!value) {
    return '<none>';
  }

  return value.length > STATUS_MESSAGE_MAX_CHARS ? `${value.slice(0, STATUS_MESSAGE_MAX_CHARS)}…` : value;
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

export type EnvironmentServiceLineDetail = 'full' | 'roster';

export function formatEnvironmentServiceLine(
  service: AgentSessionPromptServiceContext,
  detail: EnvironmentServiceLineDetail
): string {
  const full = detail === 'full';
  // Edges surface only where they inform diagnosis; healthy roster lines stay lean.
  const showDependsOn = Boolean(service.dependsOn?.length) && (full || service.status !== 'deployed');
  const details = formatDetails([
    service.deployUuid ? `deployUuid=${service.deployUuid}` : undefined,
    service.active !== undefined ? `active=${service.active}` : undefined,
    service.status ? `status=${service.status}` : undefined,
    `statusMessage=${formatStatusMessage(service.statusMessage)}`,
    showDependsOn ? `dependsOn=${service.dependsOn!.join('|')}` : undefined,
    service.repo ? `repo=${service.repo}` : undefined,
    service.branch ? `branch=${service.branch}` : undefined,
    full && service.serviceSha ? `serviceSha=${service.serviceSha}` : undefined,
    full && service.dockerfilePath ? `dockerfilePath=${service.dockerfilePath}` : undefined,
    full && service.initDockerfilePath ? `initDockerfilePath=${service.initDockerfilePath}` : undefined,
    full && service.deployableType ? `type=${service.deployableType}` : undefined,
    full && service.source ? `source=${service.source}` : undefined,
    full && service.chartName ? `chartName=${service.chartName}` : undefined,
    full && service.chartRepoUrl ? `chartRepoUrl=${service.chartRepoUrl}` : undefined,
    full && service.chartValueFiles?.length ? `chartValueFiles=${service.chartValueFiles.join('|')}` : undefined,
    service.publicUrl ? `publicUrl=${service.publicUrl}` : undefined,
    service.dockerImage ? `dockerImage=${service.dockerImage}` : undefined,
    service.buildPipelineId ? `buildPipelineId=${service.buildPipelineId}` : undefined,
    service.deployPipelineId ? `deployPipelineId=${service.deployPipelineId}` : undefined,
    full && service.workspacePath ? `workspacePath=${service.workspacePath}` : undefined,
    full && service.workDir ? `workDir=${service.workDir}` : undefined,
  ]);

  return `- ${service.name}${details ? `: ${details}` : ''}`;
}

export function formatEnvironmentBuildLine(build: AgentSessionPromptBuildContext): string {
  const details = formatDetails([
    build.status ? `status=${build.status}` : undefined,
    `statusMessage=${formatStatusMessage(build.statusMessage)}`,
    build.namespace ? `namespace=${build.namespace}` : undefined,
    build.sha ? `sha=${build.sha}` : undefined,
  ]);

  return `- build=${build.uuid}${details ? `: ${details}` : ''}`;
}

export function formatEnvironmentPullRequestLine(pr: AgentSessionPromptPullRequestContext): string | undefined {
  const details = formatDetails([
    pr.fullName ? `repo=${pr.fullName}` : undefined,
    pr.branchName ? `branch=${pr.branchName}` : undefined,
    pr.pullRequestNumber != null ? `number=${pr.pullRequestNumber}` : undefined,
    pr.url ? `url=${pr.url}` : undefined,
    pr.status ? `status=${pr.status}` : undefined,
    `labels=${formatOptionalStringArray(pr.labels)}`,
    `deployOnUpdate=${formatOptionalBoolean(pr.deployOnUpdate)}`,
    `deployLabels=${formatOptionalStringArray(pr.deployLabels)}`,
    `disabledLabels=${formatOptionalStringArray(pr.disabledLabels)}`,
    pr.latestCommit ? `latestCommit=${pr.latestCommit}` : undefined,
    pr.repositoryUrl ? `repositoryUrl=${pr.repositoryUrl}` : undefined,
  ]);

  return details ? `- ${details}` : undefined;
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
  buildRow?: Build;
  pullRequest?: AgentSessionPromptPullRequestContext;
  lifecycleConfig?: AgentSessionPromptLifecycleConfigContext;
  deploys: Deploy[];
  diagnosticServices: AgentSessionPromptServiceContext[];
};

// Representative config path in the snapshot; actual file may be a .lifecycle.yaml/.yml variant.
const LIFECYCLE_CONFIG_PATH = 'lifecycle.yaml';

// Detect missing/invalid lifecycle.yaml (a common root cause) for the snapshot without throwing; seeds the shared cache.
async function resolveLifecycleConfigPresence(
  repo: string | undefined,
  branch: string | undefined,
  cache: Map<string, Promise<LifecycleConfig | null>>
): Promise<AgentSessionPromptLifecycleConfigContext | undefined> {
  if (!repo || !branch) {
    return undefined;
  }

  // fetchLifecycleConfig returns null when absent, throws on parse errors: distinguishes missing from invalid.
  const key = `${repo}::${branch}`;
  let fetchPromise = cache.get(key);
  if (!fetchPromise) {
    fetchPromise = fetchLifecycleConfig(repo, branch).then((config) => config ?? null);
    // Shared cache stores a non-throwing variant for the workDir path.
    cache.set(
      key,
      fetchPromise.catch(() => null)
    );
  }

  try {
    const config = await fetchPromise;
    if (!config) {
      return { status: 'missing', path: LIFECYCLE_CONFIG_PATH };
    }

    const declaredServices = Array.isArray(config.services)
      ? config.services
          .map((service) => normalizeOptionalString(service?.name))
          .filter((name): name is string => Boolean(name))
      : [];

    return {
      status: 'present',
      path: LIFECYCLE_CONFIG_PATH,
      ...(declaredServices.length ? { declaredServices } : {}),
    };
  } catch {
    return { status: 'invalid', path: LIFECYCLE_CONFIG_PATH };
  }
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

function buildPullRequestUrl(fullName?: string, pullRequestNumber?: number): string | undefined {
  if (!fullName || pullRequestNumber == null) {
    return undefined;
  }

  return `https://github.com/${fullName}/pull/${pullRequestNumber}`;
}

// Declared dependency edges, minus self-references the deployment manager also strips.
function normalizeDependsOn(serviceName: string, value: unknown): string[] | undefined {
  const dependsOn = normalizeStringArray(value)?.filter((dependency) => dependency !== serviceName);
  return dependsOn?.length ? dependsOn : undefined;
}

function formatDeployDiagnosticService(
  deploy: Deploy,
  buildSource: { repo?: string; branch?: string }
): AgentSessionPromptServiceContext | null {
  const name = normalizeOptionalString(deploy.deployable?.name) || normalizeOptionalString(deploy.uuid);

  if (!name) {
    return null;
  }

  const dependsOn = normalizeDependsOn(name, deploy.deployable?.deploymentDependsOn);

  return {
    name,
    active: typeof deploy.active === 'boolean' ? deploy.active : undefined,
    deployUuid: normalizeOptionalString(deploy.uuid),
    status: normalizeOptionalString(deploy.status),
    statusMessage: normalizeOptionalString(deploy.statusMessage),
    publicUrl: formatPublicUrl(deploy.publicUrl),
    repo: normalizeOptionalString(deploy.repository?.fullName) || buildSource.repo,
    branch: normalizeOptionalString(deploy.branchName) || buildSource.branch,
    ...(dependsOn ? { dependsOn } : {}),
    dockerImage: normalizeOptionalString(deploy.dockerImage),
    buildPipelineId: normalizeOptionalString(deploy.buildPipelineId),
    deployPipelineId: normalizeOptionalString(deploy.deployPipelineId),
  };
}

async function resolveBuildDiagnosticContext(
  buildUuid: string | null | undefined,
  lifecycleConfigCache: Map<string, Promise<LifecycleConfig | null>>
): Promise<BuildDiagnosticContext> {
  const normalizedBuildUuid = normalizeOptionalString(buildUuid);
  if (!normalizedBuildUuid) {
    return { source: {}, deploys: [], diagnosticServices: [] };
  }

  const build = await Build.query()
    .findOne({ uuid: normalizedBuildUuid })
    .withGraphFetched('[pullRequest.[repository], deploys.[deployable, repository]]');
  const labelsConfig = await GlobalConfigService.getInstance()
    .getLabels()
    .catch(() => undefined);
  const pullRequest = build?.pullRequest;
  const pullRequestNumber = pullRequest?.pullRequestNumber;
  const source = {
    repo: normalizeOptionalString(pullRequest?.fullName),
    branch: normalizeOptionalString(pullRequest?.branchName),
  };
  const lifecycleConfig = await resolveLifecycleConfigPresence(source.repo, source.branch, lifecycleConfigCache);

  return {
    source,
    lifecycleConfig,
    buildRow: build || undefined,
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

// Triage-only resolution for callers that already have a DB-only context and later decide they need evidence.
export async function resolveAgentSessionTriage(buildUuid: string | null | undefined): Promise<string | null> {
  const normalizedBuildUuid = normalizeOptionalString(buildUuid);
  if (!normalizedBuildUuid) {
    return null;
  }

  const build = await Build.query().findOne({ uuid: normalizedBuildUuid }).withGraphFetched('[deploys.[deployable]]');
  if (!build) {
    return null;
  }

  try {
    return await buildTriageDossier(build, build.deploys || []);
  } catch (error) {
    return `- triage: unavailable (${(error as Error)?.message || 'unknown error'})`;
  }
}

export async function resolveAgentSessionPromptContext(
  lookup: SessionPromptLookupContext
): Promise<AgentSessionPromptContext> {
  const lifecycleConfigCache = new Map<string, Promise<LifecycleConfig | null>>();
  const [session, deploys, buildSource] = await Promise.all([
    AgentSession.query().findById(lookup.sessionDbId),
    Deploy.query().where({ devModeSessionId: lookup.sessionDbId }).withGraphFetched('[deployable, repository]'),
    resolveBuildDiagnosticContext(lookup.buildUuid, lifecycleConfigCache),
  ]);
  const allDeploys = deploys.length > 0 ? deploys : buildSource.deploys;
  const deployById = new Map(allDeploys.filter((deploy) => deploy.id != null).map((deploy) => [deploy.id, deploy]));

  let services: AgentSessionPromptServiceContext[];

  if (session?.selectedServices?.length) {
    services = session.selectedServices.map((service) => {
      const deploy = deployById.get(service.deployId);
      const dependsOn = normalizeDependsOn(service.name, deploy?.deployable?.deploymentDependsOn);

      return {
        name: service.name,
        active: typeof deploy?.active === 'boolean' ? deploy.active : undefined,
        publicUrl: formatPublicUrl(deploy?.publicUrl),
        repo: normalizeOptionalString(service.repo),
        branch: normalizeOptionalString(service.branch),
        ...(dependsOn ? { dependsOn } : {}),
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
          const serviceName = normalizeOptionalString(deploy.deployable?.name) || normalizeOptionalString(deploy.uuid);

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

          const dependsOn = normalizeDependsOn(serviceName, deploy.deployable?.deploymentDependsOn);

          return {
            name: serviceName,
            active: typeof deploy.active === 'boolean' ? deploy.active : undefined,
            deployUuid: normalizeOptionalString(deploy.uuid),
            status: normalizeOptionalString(deploy.status),
            statusMessage: normalizeOptionalString(deploy.statusMessage),
            publicUrl: formatPublicUrl(deploy.publicUrl),
            repo: repositoryName,
            branch: branchName,
            ...(dependsOn ? { dependsOn } : {}),
            dockerImage: normalizeOptionalString(deploy.dockerImage),
            buildPipelineId: normalizeOptionalString(deploy.buildPipelineId),
            deployPipelineId: normalizeOptionalString(deploy.deployPipelineId),
            workDir,
          };
        })
      )
    ).filter((service): service is AgentSessionPromptServiceContext => Boolean(service));
  }

  // Only present a "selected" deploy when the session points at one (explicit selection or
  // devMode-attached deploys) — the all-build-deploys fallback is DB-ordered and would bias
  // the model toward an arbitrary service.
  const hasUserSelection = Boolean(session?.selectedServices?.length) || deploys.length > 0;

  let triage: string | undefined;
  if (buildSource.buildRow && lookup.includeTriage !== false) {
    try {
      triage = (await buildTriageDossier(buildSource.buildRow, buildSource.deploys)) ?? undefined;
    } catch (error) {
      triage = `- triage: unavailable (${(error as Error)?.message || 'unknown error'})`;
    }
  }

  return {
    namespace: lookup.namespace,
    buildUuid: lookup.buildUuid,
    gatheredAt: new Date().toISOString(),
    build: buildSource.build,
    pullRequest: buildSource.pullRequest,
    ...(buildSource.lifecycleConfig ? { lifecycleConfig: buildSource.lifecycleConfig } : {}),
    services,
    userSelectedServices: hasUserSelection,
    ...(hasUserSelection && services[0]?.deployUuid ? { selectedDeploy: services[0] } : {}),
    diagnosticServices: buildSource.diagnosticServices,
    ...(triage ? { triage } : {}),
  };
}
