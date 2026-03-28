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

import type { DevConfig } from 'server/models/yaml/YamlService';
import {
  AGENT_WORKSPACE_ROOT,
  normalizeAgentWorkspaceRepo,
  repoNameFromRepoUrl,
  rewriteWorkspacePathForRepo,
  rewriteWorkspaceScriptForRepo,
  type AgentSessionSelectedService,
  type AgentSessionWorkspaceRepo,
} from './workspace';

type WorkspaceRepoInput = Pick<AgentSessionWorkspaceRepo, 'repo' | 'repoUrl' | 'branch' | 'revision'> & {
  primary?: boolean;
};

export interface AgentSessionWorkspaceRepoResolutionOpts {
  repoUrl?: string | null;
  branch?: string | null;
  revision?: string | null;
  workspaceRepos?: AgentSessionWorkspaceRepo[] | null;
}

export interface AgentSessionServiceInput {
  name: string;
  deployId: number;
  devConfig: DevConfig;
  resourceName?: string | null;
  repo?: string | null;
  branch?: string | null;
  revision?: string | null;
  workspacePath?: string;
  workDir?: string | null;
}

export type ResolvedAgentSessionService<T extends AgentSessionServiceInput> = Omit<
  T,
  'repo' | 'branch' | 'revision' | 'workspacePath' | 'workDir' | 'devConfig'
> & {
  devConfig: DevConfig;
  repo: string;
  branch: string;
  revision: string | null;
  workspacePath: string;
  workDir: string;
};

export function workspaceRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function rewriteWorkspaceEnvForRepo(
  env: Record<string, string> | undefined,
  repoRoot: string
): Record<string, string> | undefined {
  if (!env) {
    return env;
  }

  return Object.fromEntries(
    Object.entries(env).map(([envKey, envValue]) => [
      envKey,
      typeof envValue === 'string' ? rewriteWorkspaceScriptForRepo(envValue, repoRoot) : envValue,
    ])
  );
}

export function rewriteDevConfigForWorkspaceRepo(devConfig: DevConfig, repoRoot: string): DevConfig {
  return {
    ...devConfig,
    ...(devConfig.workDir
      ? { workDir: rewriteWorkspacePathForRepo(devConfig.workDir, repoRoot) }
      : { workDir: repoRoot }),
    ...(devConfig.command ? { command: rewriteWorkspaceScriptForRepo(devConfig.command, repoRoot) } : {}),
    ...(devConfig.installCommand
      ? { installCommand: rewriteWorkspaceScriptForRepo(devConfig.installCommand, repoRoot) }
      : {}),
    ...(devConfig.env ? { env: rewriteWorkspaceEnvForRepo(devConfig.env, repoRoot) } : {}),
  };
}

export function resolveAgentSessionWorkspaceRepos(
  opts: AgentSessionWorkspaceRepoResolutionOpts,
  services: ReadonlyArray<Pick<AgentSessionServiceInput, 'repo' | 'branch' | 'revision'>> | undefined
): AgentSessionWorkspaceRepo[] {
  const inputs: WorkspaceRepoInput[] = [];

  if (opts.workspaceRepos?.length) {
    inputs.push(...opts.workspaceRepos);
  } else if (opts.repoUrl && opts.branch) {
    const repo = repoNameFromRepoUrl(opts.repoUrl);
    if (!repo) {
      throw new Error('Unable to resolve repository name from repoUrl');
    }

    inputs.push({
      repo,
      repoUrl: opts.repoUrl,
      branch: opts.branch,
      revision: opts.revision || null,
      primary: true,
    });
  }

  for (const service of services || []) {
    if (!service.repo || !service.branch) {
      continue;
    }

    inputs.push({
      repo: service.repo,
      repoUrl: `https://github.com/${service.repo}.git`,
      branch: service.branch,
      revision: service.revision || null,
    });
  }

  if (inputs.length === 0) {
    throw new Error('At least one workspace repository is required');
  }

  const orderedKeys: string[] = [];
  const reposByKey = new Map<string, WorkspaceRepoInput>();
  let primaryKey: string | null = null;

  for (const input of inputs) {
    const key = workspaceRepoKey(input.repo);
    const existing = reposByKey.get(key);

    if (!existing) {
      reposByKey.set(key, { ...input });
      orderedKeys.push(key);
    } else {
      if (existing.branch !== input.branch) {
        throw new Error(
          `Selected services require conflicting branches for ${input.repo}: ${existing.branch} and ${input.branch}`
        );
      }

      if (existing.revision && input.revision && existing.revision !== input.revision) {
        throw new Error(
          `Selected services require conflicting revisions for ${input.repo}: ${existing.revision} and ${input.revision}`
        );
      }

      reposByKey.set(key, {
        ...existing,
        repoUrl: existing.repoUrl || input.repoUrl,
        revision: existing.revision || input.revision || null,
        primary: existing.primary || input.primary,
      });
    }

    if (input.primary) {
      if (primaryKey && primaryKey !== key) {
        throw new Error(
          `Multiple primary repositories were requested: ${reposByKey.get(primaryKey)?.repo} and ${input.repo}`
        );
      }

      primaryKey = key;
    }
  }

  const resolvedPrimaryKey = primaryKey || orderedKeys[0];

  return orderedKeys.map((key) => {
    const repo = reposByKey.get(key)!;
    return normalizeAgentWorkspaceRepo(repo, key === resolvedPrimaryKey);
  });
}

export function applyWorkspaceReposToServices<T extends AgentSessionServiceInput>(
  services: ReadonlyArray<T> | undefined,
  workspaceRepos: AgentSessionWorkspaceRepo[]
): {
  services: Array<ResolvedAgentSessionService<T>> | undefined;
  selectedServices: AgentSessionSelectedService[];
} {
  if (!services?.length) {
    return { services: services ? [] : undefined, selectedServices: [] };
  }

  const primaryRepo = workspaceRepos.find((repo) => repo.primary) || workspaceRepos[0];
  const reposByKey = new Map(workspaceRepos.map((repo) => [workspaceRepoKey(repo.repo), repo]));

  const adjustedServices = services.map((service) => {
    const serviceRepo = service.repo || primaryRepo.repo;
    const repo = reposByKey.get(workspaceRepoKey(serviceRepo));
    if (!repo) {
      throw new Error(`Workspace repository missing for selected service ${service.name} in ${serviceRepo}`);
    }

    const effectiveBranch = service.branch || repo.branch;
    const effectiveRevision = service.revision || repo.revision || null;
    const effectiveDevConfig = rewriteDevConfigForWorkspaceRepo(service.devConfig, repo.mountPath);
    const effectiveWorkDir = effectiveDevConfig.workDir || repo.mountPath;

    return {
      ...service,
      repo: repo.repo,
      branch: effectiveBranch,
      revision: effectiveRevision,
      workspacePath: repo.mountPath,
      workDir: effectiveWorkDir,
      devConfig: effectiveDevConfig,
    } satisfies ResolvedAgentSessionService<T>;
  });

  return {
    services: adjustedServices,
    selectedServices: adjustedServices.map((service) => ({
      name: service.name,
      deployId: service.deployId,
      repo: service.repo,
      branch: service.branch,
      revision: service.revision || null,
      resourceName: service.resourceName || null,
      workspacePath: service.workspacePath,
      workDir: service.workDir || null,
    })),
  };
}

export function resolveAgentSessionServicePlan<T extends AgentSessionServiceInput>(
  opts: AgentSessionWorkspaceRepoResolutionOpts,
  services: ReadonlyArray<T> | undefined
): {
  workspaceRepos: AgentSessionWorkspaceRepo[];
  services: Array<ResolvedAgentSessionService<T>> | undefined;
  selectedServices: AgentSessionSelectedService[];
} {
  const workspaceRepos = resolveAgentSessionWorkspaceRepos(opts, services);
  const resolvedServices = applyWorkspaceReposToServices(services, workspaceRepos);

  return {
    workspaceRepos,
    ...resolvedServices,
  };
}

export function buildCombinedInstallCommand<T extends Pick<AgentSessionServiceInput, 'devConfig' | 'workspacePath'>>(
  services: ReadonlyArray<T> | undefined
): string | undefined {
  const installCommands = (services || [])
    .map((service) => {
      const installCommand = service.devConfig.installCommand?.trim();
      const workspacePath = service.workspacePath?.trim();
      if (!installCommand || !workspacePath) {
        return null;
      }

      if (
        workspacePath === AGENT_WORKSPACE_ROOT ||
        installCommand.includes(AGENT_WORKSPACE_ROOT) ||
        /(^|\n)\s*cd\s+/.test(installCommand)
      ) {
        return installCommand;
      }

      return `cd "${workspacePath}"\n${installCommand}`;
    })
    .filter((command): command is string => Boolean(command));

  return installCommands.length > 0 ? installCommands.join('\n\n') : undefined;
}
