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
import type { Deploy } from 'server/models';
import { getBuildSource, resolveBuildSourceRepository } from 'server/lib/buildSource';
import { fetchLifecycleConfig, getDeployingServicesByName, type LifecycleConfig } from 'server/models/yaml';
import {
  getDeployType,
  hasLifecycleManagedDockerBuild,
  type DevConfig,
  type Service as LifecycleService,
} from 'server/models/yaml/YamlService';
import { DeployTypes } from 'shared/constants';

export interface AgentSessionServiceCandidate {
  name: string;
  type: DeployTypes;
  detail?: string;
  deployId: number;
  devConfig: DevConfig;
  repo: string;
  branch: string;
  revision?: string | null;
  baseDeploy: Deploy;
}

export interface RequestedAgentSessionServiceRef {
  name: string;
  repo?: string | null;
  branch?: string | null;
}

export interface AgentSessionCandidateBuildSource {
  repo: string;
  branch: string;
  configRef: string;
  githubRepositoryId: number | null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRepoKey(value: string): string {
  return value.trim().toLowerCase();
}

function buildLifecycleConfigCacheKey(repo: string, branch: string): string {
  return `${normalizeRepoKey(repo)}::${branch.trim()}`;
}

async function fetchCachedLifecycleConfig(
  repo: string,
  branch: string,
  cache: Map<string, Promise<LifecycleConfig | null>>
): Promise<LifecycleConfig | null> {
  const cacheKey = buildLifecycleConfigCacheKey(repo, branch);
  let promise = cache.get(cacheKey);

  if (!promise) {
    promise = fetchLifecycleConfig(repo, branch).catch(() => null);
    cache.set(cacheKey, promise);
  }

  return promise;
}

async function resolveCandidateForDeploy(
  deploy: Deploy,
  buildSource: AgentSessionCandidateBuildSource,
  lifecycleConfigCache: Map<string, Promise<LifecycleConfig | null>>
): Promise<AgentSessionServiceCandidate | null> {
  const serviceName = normalizeOptionalString(deploy.deployable?.name) || normalizeOptionalString(deploy.uuid);
  const deployRepositoryFullName = normalizeOptionalString(deploy.repository?.fullName);
  const deployRepositoryId = deploy.repository?.githubRepositoryId ?? deploy.githubRepositoryId;
  const isBuildSourceRepository =
    buildSource.githubRepositoryId != null && deployRepositoryId != null
      ? Number(buildSource.githubRepositoryId) === Number(deployRepositoryId)
      : deployRepositoryFullName != null &&
        normalizeRepoKey(deployRepositoryFullName) === normalizeRepoKey(buildSource.repo);
  const repo = deployRepositoryFullName || (isBuildSourceRepository ? buildSource.repo : undefined);
  const deployBranch = normalizeOptionalString(deploy.branchName);
  // A pinned API build currently stores the immutable config SHA in deploy.branchName. That SHA is
  // the config lookup ref, not the user-facing checkout branch. A genuine same-repository service
  // override, however, must remain the checkout branch selected for that deploy.
  const branch =
    isBuildSourceRepository && deployBranch === buildSource.configRef
      ? buildSource.branch
      : deployBranch || buildSource.branch;
  const configRef = isBuildSourceRepository ? buildSource.configRef : deployBranch || branch;

  if (!deploy.active || !deploy.id || !serviceName || !repo || !branch || !configRef) {
    return null;
  }

  const lifecycleConfig = await fetchCachedLifecycleConfig(repo, configRef, lifecycleConfigCache);
  if (!lifecycleConfig) {
    return null;
  }

  const yamlService = getDeployingServicesByName(lifecycleConfig, serviceName);
  if (!yamlService || !isSessionSelectableService(yamlService)) {
    return null;
  }

  return {
    name: yamlService.name,
    type: getDeployType(yamlService),
    detail: deploy.status,
    deployId: deploy.id,
    devConfig: yamlService.dev!,
    repo,
    branch,
    revision: normalizeOptionalString(deploy.sha) || null,
    baseDeploy: deploy,
  };
}

export async function loadAgentSessionServiceCandidates(buildUuid: string): Promise<AgentSessionServiceCandidate[]> {
  const build = await Build.query()
    .findOne({ uuid: buildUuid })
    .whereNull('deletedAt')
    .withGraphFetched('[pullRequest.[repository], deploys.[deployable, repository]]');
  if (!build) {
    throw new Error('Build not found');
  }

  return resolveAgentSessionServiceCandidatesForBuild(build);
}

export async function resolveAgentSessionCandidateBuildSource(
  build: Build
): Promise<AgentSessionCandidateBuildSource | null> {
  const source = getBuildSource(build);
  const repository = await resolveBuildSourceRepository(build);
  const repo = normalizeOptionalString(source.pullRequest ? source.fullName : repository?.fullName);
  const branch = normalizeOptionalString(source.branchName);

  if (!repo || !branch) {
    return null;
  }

  return {
    repo,
    branch,
    configRef: normalizeOptionalString(source.configSha) || branch,
    githubRepositoryId:
      repository?.githubRepositoryId != null
        ? Number(repository.githubRepositoryId)
        : source.githubRepositoryId != null
        ? Number(source.githubRepositoryId)
        : null,
  };
}

export function resolveRequestedAgentSessionServices(
  candidates: AgentSessionServiceCandidate[],
  requestedServices: Array<string | RequestedAgentSessionServiceRef>
): AgentSessionServiceCandidate[] {
  const missingServices: string[] = [];
  const ambiguousServices: string[] = [];

  const resolved = requestedServices.flatMap((requestedService) => {
    const serviceName = typeof requestedService === 'string' ? requestedService : requestedService.name;
    const requestedRepo =
      typeof requestedService === 'string' ? undefined : normalizeOptionalString(requestedService.repo);
    const requestedBranch =
      typeof requestedService === 'string' ? undefined : normalizeOptionalString(requestedService.branch);
    const matches = candidates.filter((candidate) => {
      if (candidate.name !== serviceName) {
        return false;
      }

      if (requestedRepo && normalizeRepoKey(candidate.repo) !== normalizeRepoKey(requestedRepo)) {
        return false;
      }

      if (requestedBranch && candidate.branch !== requestedBranch) {
        return false;
      }

      return true;
    });

    if (matches.length === 0) {
      missingServices.push(
        requestedRepo && requestedBranch ? `${serviceName} (${requestedRepo}:${requestedBranch})` : serviceName
      );
      return [];
    }

    if (matches.length > 1) {
      ambiguousServices.push(
        requestedRepo
          ? `${serviceName} (${requestedRepo}${requestedBranch ? `:${requestedBranch}` : ''})`
          : `${serviceName} (${matches.map((match) => `${match.repo}:${match.branch}`).join(', ')})`
      );
      return [];
    }

    return [matches[0]];
  });

  if (missingServices.length > 0) {
    throw new Error(`Unknown services for build: ${missingServices.join(', ')}`);
  }

  if (ambiguousServices.length > 0) {
    throw new Error(
      `Multiple services matched the request; specify repo to disambiguate: ${ambiguousServices.join(', ')}`
    );
  }

  return resolved;
}

export async function resolveAgentSessionServiceCandidatesForBuild(
  build: Build,
  buildSource?: AgentSessionCandidateBuildSource | null
): Promise<AgentSessionServiceCandidate[]> {
  const resolvedBuildSource = buildSource ?? (await resolveAgentSessionCandidateBuildSource(build));
  if (!resolvedBuildSource) {
    throw new Error('Build source not found');
  }

  const lifecycleConfigCache = new Map<string, Promise<LifecycleConfig | null>>();
  const candidates = await Promise.all(
    (build.deploys || []).map((deploy) => resolveCandidateForDeploy(deploy, resolvedBuildSource, lifecycleConfigCache))
  );

  return candidates
    .filter((candidate): candidate is AgentSessionServiceCandidate => Boolean(candidate))
    .sort((left, right) => {
      if (left.name === right.name) {
        return `${left.repo}:${left.branch}`.localeCompare(`${right.repo}:${right.branch}`);
      }

      return left.name.localeCompare(right.name);
    });
}

export function resolveAgentSessionServiceCandidates(
  deploys: Deploy[],
  lifecycleConfig: LifecycleConfig
): AgentSessionServiceCandidate[] {
  const activeDeploysByName = new Map(
    deploys
      .filter((deploy) => deploy.active && deploy.deployable?.name && deploy.id != null)
      .map((deploy) => [deploy.deployable!.name, deploy])
  );

  return lifecycleConfig.services.flatMap((service) => {
    if (!isSessionSelectableService(service)) {
      return [];
    }

    const baseDeploy = activeDeploysByName.get(service.name);
    if (!baseDeploy?.id) {
      return [];
    }

    return [
      {
        name: service.name,
        type: getDeployType(service),
        detail: baseDeploy.status,
        deployId: baseDeploy.id,
        devConfig: service.dev!,
        repo: normalizeOptionalString(baseDeploy.repository?.fullName) || '',
        branch: normalizeOptionalString(baseDeploy.branchName) || '',
        revision: normalizeOptionalString(baseDeploy.sha) || null,
        baseDeploy,
      },
    ];
  });
}

function isSessionSelectableService(service: LifecycleService): boolean {
  return !!service.dev && hasLifecycleManagedDockerBuild(service);
}
