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

type AgentSessionCandidateBuildContext = {
  pullRequest?: {
    fullName?: string | null;
    branchName?: string | null;
  } | null;
  deploys?: Deploy[] | null;
};

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
  buildSource: { repo?: string; branch?: string },
  lifecycleConfigCache: Map<string, Promise<LifecycleConfig | null>>
): Promise<AgentSessionServiceCandidate | null> {
  const serviceName =
    normalizeOptionalString(deploy.deployable?.name) ||
    normalizeOptionalString(deploy.service?.name) ||
    normalizeOptionalString(deploy.uuid);
  const repo = normalizeOptionalString(deploy.repository?.fullName) || buildSource.repo;
  const branch = normalizeOptionalString(deploy.branchName) || buildSource.branch;

  if (!deploy.active || !deploy.id || !serviceName || !repo || !branch) {
    return null;
  }

  const lifecycleConfig = await fetchCachedLifecycleConfig(repo, branch, lifecycleConfigCache);
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
    .withGraphFetched('[pullRequest, deploys.[deployable, repository, service]]');
  if (!build?.pullRequest) {
    throw new Error('Build not found');
  }

  return resolveAgentSessionServiceCandidatesForBuild(build);
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
  build: AgentSessionCandidateBuildContext
): Promise<AgentSessionServiceCandidate[]> {
  const buildSource = {
    repo: normalizeOptionalString(build.pullRequest?.fullName),
    branch: normalizeOptionalString(build.pullRequest?.branchName),
  };
  const lifecycleConfigCache = new Map<string, Promise<LifecycleConfig | null>>();
  const candidates = await Promise.all(
    (build.deploys || []).map((deploy) => resolveCandidateForDeploy(deploy, buildSource, lifecycleConfigCache))
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
