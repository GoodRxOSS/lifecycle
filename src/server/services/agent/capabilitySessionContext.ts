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
import { getLogger } from 'server/lib/logger';
import type { AgentRuntimeConfig } from 'server/services/types/agentRuntimeConfig';
import type { LifecycleDiagnosticGithubSafety } from './diagnosticTools';
import { YamlConfigParser } from 'server/lib/yamlConfigParser';
import type { LifecycleConfig } from 'server/models/yaml/Config';
import Build from 'server/models/Build';
import type { DatabaseBuildScope } from 'server/services/agent/tools/shared/databaseClient';

const LIFECYCLE_CONFIG_WRITE_PATTERNS = ['lifecycle.yaml', 'lifecycle.yml'];

export function resolvePrimaryRepo(session: AgentSession): string | undefined {
  const primaryRepo = (session.workspaceRepos || []).find((repo) => repo.primary)?.repo;
  if (primaryRepo) {
    return primaryRepo;
  }

  return session.selectedServices?.[0]?.repo || undefined;
}

function resolvePrimaryBranch(session: AgentSession): string | null {
  const primaryWorkspaceRepo =
    (session.workspaceRepos || []).find((repo) => repo.primary) || session.workspaceRepos?.[0];
  if (primaryWorkspaceRepo?.branch) {
    return primaryWorkspaceRepo.branch;
  }

  return session.selectedServices?.[0]?.branch || null;
}

function addReferencedFile(files: Set<string>, value: unknown) {
  if (typeof value !== 'string') {
    return;
  }

  const normalized = value.trim().replace(/^\/+/, '').replace(/^\.\//, '');
  if (normalized) {
    files.add(normalized);
  }
}

function collectLifecycleConfigReferencedFiles(config: LifecycleConfig | null | undefined): string[] {
  const files = new Set<string>();

  for (const service of config?.services || []) {
    const candidate = service as Record<string, any>;
    addReferencedFile(files, candidate.github?.docker?.app?.dockerfilePath);
    addReferencedFile(files, candidate.github?.docker?.init?.dockerfilePath);
    addReferencedFile(files, candidate.helm?.docker?.app?.dockerfilePath);
    addReferencedFile(files, candidate.helm?.docker?.init?.dockerfilePath);
    addReferencedFile(files, candidate.helm?.envMapping?.app?.path);
    addReferencedFile(files, candidate.helm?.envMapping?.init?.path);

    for (const valueFile of candidate.helm?.chart?.valueFiles || []) {
      addReferencedFile(files, valueFile);
    }
  }

  return [...files];
}

function collectSelectedDeployReferencedFiles(session: AgentSession): string[] {
  const files = new Set<string>();
  const selectedService = session.selectedServices?.[0];
  if (!selectedService) {
    return [];
  }

  addReferencedFile(files, selectedService.dockerfilePath);
  addReferencedFile(files, selectedService.initDockerfilePath);
  for (const valueFile of selectedService.chartValueFiles || []) {
    addReferencedFile(files, valueFile);
  }

  return [...files];
}

type LifecycleDiagnosticBuildScope = {
  allowedNamespace: string | null;
  allowedRepos: string[];
  buildUuid: string | null;
  pullRequestId: number | null;
  allowedPullRequestNumber: number | null;
  databaseScope: DatabaseBuildScope | null;
};

function addRepoFullName(repos: Set<string>, value: unknown) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized.includes('/')) {
      repos.add(normalized);
    }
  }
}

/** SECURITY: every diagnostic tool is locked to this scope (namespace, full repo set, build UUID, PR id, DB scope) from the authoritative Build row; falls back to session repos if it can't load. */
async function resolveLifecycleDiagnosticBuildScope(session: AgentSession): Promise<LifecycleDiagnosticBuildScope> {
  const repos = new Set<string>();
  // Always include repos already known on the session as a baseline.
  for (const workspaceRepo of session.workspaceRepos || []) {
    addRepoFullName(repos, workspaceRepo.repo);
  }
  for (const selectedService of session.selectedServices || []) {
    addRepoFullName(repos, selectedService.repo);
  }

  const scope: LifecycleDiagnosticBuildScope = {
    allowedNamespace: null,
    allowedRepos: [...repos],
    buildUuid: session.buildUuid || null,
    pullRequestId: null,
    allowedPullRequestNumber: null,
    databaseScope: null,
  };

  if (!session.buildUuid) {
    return scope;
  }

  try {
    const build = await Build.query()
      .findOne({ uuid: session.buildUuid })
      .withGraphFetched('[pullRequest.repository, deploys.repository]');
    if (!build) {
      return scope;
    }

    addRepoFullName(repos, build.pullRequest?.repository?.fullName);
    addRepoFullName(repos, build.pullRequest?.fullName);
    for (const deploy of build.deploys || []) {
      addRepoFullName(repos, deploy.repository?.fullName);
    }

    const pullRequestId =
      typeof (build as { pullRequestId?: number | null }).pullRequestId === 'number'
        ? (build as { pullRequestId?: number | null }).pullRequestId ?? null
        : build.pullRequest?.id ?? null;
    const repositoryIds = [
      ...new Set(
        [build.pullRequest?.repository?.id, ...(build.deploys || []).map((deploy) => deploy.repository?.id)].filter(
          (id): id is number => typeof id === 'number'
        )
      ),
    ];

    scope.allowedNamespace = build.namespace || null;
    scope.allowedRepos = [...repos];
    scope.pullRequestId = pullRequestId;
    scope.allowedPullRequestNumber =
      typeof build.pullRequest?.pullRequestNumber === 'number' ? build.pullRequest.pullRequestNumber : null;
    scope.databaseScope = {
      buildId: build.id,
      buildUuid: build.uuid,
      pullRequestId,
      environmentId: typeof build.environmentId === 'number' ? build.environmentId : null,
      repositoryIds,
    };
  } catch (error) {
    getLogger().warn(
      { error, buildUuid: session.buildUuid },
      `AgentExec: lifecycle diagnostic build scope unavailable buildUuid=${session.buildUuid}`
    );
  }

  return scope;
}

export async function resolveLifecycleDiagnosticGithubSafety({
  session,
  repoFullName,
  config,
}: {
  session: AgentSession;
  repoFullName?: string;
  config?: AgentRuntimeConfig | null;
}): Promise<LifecycleDiagnosticGithubSafety> {
  const allowedBranch = resolvePrimaryBranch(session);
  const allowedWritePatterns = [
    ...new Set([...LIFECYCLE_CONFIG_WRITE_PATTERNS, ...(config?.allowedWritePatterns || [])]),
  ];
  const selectedDeployReferencedFiles = collectSelectedDeployReferencedFiles(session);
  const buildScope = await resolveLifecycleDiagnosticBuildScope(session);
  const safety: LifecycleDiagnosticGithubSafety = {
    allowedBranch,
    primaryRepoFullName: repoFullName || resolvePrimaryRepo(session) || null,
    allowedWritePatterns,
    excludedFilePatterns: config?.excludedFilePatterns || [],
    referencedFiles: selectedDeployReferencedFiles,
    allowedNamespace: buildScope.allowedNamespace,
    allowedRepos: buildScope.allowedRepos,
    buildUuid: buildScope.buildUuid,
    pullRequestId: buildScope.pullRequestId,
    allowedPullRequestNumber: buildScope.allowedPullRequestNumber,
    databaseScope: buildScope.databaseScope,
  };

  if (!repoFullName || !allowedBranch) {
    return safety;
  }

  try {
    const lifecycleConfig = await new YamlConfigParser().parseYamlConfigFromBranch(repoFullName, allowedBranch);
    safety.referencedFiles = [
      ...new Set([...selectedDeployReferencedFiles, ...collectLifecycleConfigReferencedFiles(lifecycleConfig)]),
    ];
  } catch (error) {
    getLogger().warn(
      { error, repo: repoFullName, branch: allowedBranch },
      `AgentExec: lifecycle config references unavailable repo=${repoFullName} branch=${allowedBranch}`
    );
  }

  return safety;
}

export async function loadLatestSession(sessionUuid: string): Promise<AgentSession> {
  const session = await AgentSession.query().findOne({ uuid: sessionUuid });
  if (!session) {
    throw new Error('Agent session not found');
  }

  return session;
}
