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
import type Deploy from 'server/models/Deploy';
import { getBuildSource, isDeployEnabled } from 'server/lib/buildSource';
import { scrubSecretsFromText } from 'server/lib/secretScrub';
import { compactStatusMessage } from 'server/lib/terminalFailure';
import { getEnvironmentPhase, isDeployFailure, isEnvironmentReady } from 'server/lib/environments/readiness';
import { normalizeMcpDateTime } from '../../dateTime';
import { buildLifecycleUiEnvironmentUrl } from './environmentUrl';

export type McpEnvironmentFormat = 'concise' | 'detailed';

export interface McpEnvironmentServiceDto {
  name: string;
  type: string;
  status: string;
  active: boolean;
  url?: string;
  branch?: string;
  statusMessage?: string;
  sha?: string;
  dockerImage?: string;
  dependsOn?: string[];
}

export interface McpEnvironmentDto {
  format: McpEnvironmentFormat;
  uuid: string;
  environmentId: number;
  lifecycleUiUrl?: string;
  status: string;
  phase: ReturnType<typeof getEnvironmentPhase>;
  statusMessage?: string;
  repository: string;
  branch: string;
  trigger: 'api' | 'github_pr';
  isStatic: boolean;
  deployEnabled: boolean;
  autoTrack: boolean;
  expiresAt?: string;
  ready: boolean;
  currentDeployId?: string;
  services: McpEnvironmentServiceDto[];
  servicesTruncated: boolean;
  failingServices: string[];
  configSha?: string;
  trackDefaultBranches?: boolean;
  namespace?: string;
  createdBy?: string;
  envKeys?: string[];
  initEnvKeys?: string[];
}

export interface McpEnvironmentDtoOptions {
  repository: string;
  format?: McpEnvironmentFormat;
  maxServices?: number;
}

type DtoDeploy = Deploy & {
  deployable?: (NonNullable<Deploy['deployable']> & { type?: string; deploymentDependsOn?: string[] }) | null;
};

type DtoBuild = Omit<Build, 'deploys'> & {
  deploys?: DtoDeploy[] | null;
};

function safeText(value: string | null | undefined, max = 1000): string | undefined {
  if (!value) return undefined;
  const scrubbed = scrubSecretsFromText(compactStatusMessage(value));
  if (!scrubbed) return undefined;
  return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed;
}

function safeLabel(value: string | null | undefined, max: number): string {
  return safeText(value, max) ?? '';
}

function safeEnvironmentKeys(value: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(value ?? {})
    .map((key) => safeLabel(key, 255))
    .filter(Boolean)
    .sort()
    .slice(0, 100);
}

function serviceName(deploy: DtoDeploy): string {
  return safeLabel(deploy.deployable?.name, 100);
}

function serviceDto(deploy: DtoDeploy, detailed: boolean): McpEnvironmentServiceDto {
  // boundedDeploys already removed rows without a named deployable.
  const deployable = deploy.deployable!;
  const rawUrl = deploy.publicHref?.trim() || deploy.publicUrl?.trim() || undefined;
  const url = safeText(rawUrl, 2000);
  const statusMessage = isDeployFailure(deploy.status) ? safeText(deploy.statusMessage) : undefined;
  const dependsOn = (deployable.deploymentDependsOn ?? [])
    .map((name) => safeLabel(name, 100))
    .filter(Boolean)
    .sort();
  return {
    name: serviceName(deploy),
    type: safeLabel(deployable.type, 100) || 'unknown',
    status: deploy.status,
    active: deploy.active === true,
    ...(url ? { url } : {}),
    ...(deploy.branchName ? { branch: safeLabel(deploy.branchName, 255) } : {}),
    ...(detailed && statusMessage ? { statusMessage } : {}),
    ...(detailed && deploy.sha ? { sha: safeLabel(deploy.sha, 255) } : {}),
    ...(detailed && deploy.dockerImage ? { dockerImage: safeLabel(deploy.dockerImage, 1000) } : {}),
    ...(detailed && dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

function boundedDeploys(build: DtoBuild, maxServices: number): { deploys: DtoDeploy[]; truncated: boolean } {
  const deploys = [...(build.deploys ?? [])].filter((deploy) => serviceName(deploy));
  deploys.sort((left, right) => {
    const failureOrder = Number(isDeployFailure(right.status)) - Number(isDeployFailure(left.status));
    if (failureOrder !== 0) return failureOrder;
    const updatedOrder = (normalizeMcpDateTime(right.updatedAt) ?? '').localeCompare(
      normalizeMcpDateTime(left.updatedAt) ?? ''
    );
    return updatedOrder || serviceName(left).localeCompare(serviceName(right));
  });
  return {
    deploys: deploys.slice(0, maxServices),
    truncated: deploys.length > maxServices,
  };
}

/**
 * The sole MCP serializer for a full environment. It is intentionally
 * allowlisted: neither Build.toJSON nor Deploy.toJSON is used, and stored env,
 * initEnv, logs, manifests, internal ids, and provider metadata cannot leak.
 */
export function toMcpEnvironmentDto(build: DtoBuild, options: McpEnvironmentDtoOptions): McpEnvironmentDto {
  const format = options.format ?? 'concise';
  const maxServices = Math.max(1, Math.min(200, Math.trunc(options.maxServices ?? 100)));
  const bounded = boundedDeploys(build, maxServices);
  const failingServices = (build.deploys ?? [])
    .filter((deploy) => deploy.active && isDeployFailure(deploy.status))
    .map(serviceName)
    .filter(Boolean)
    .sort();
  const phase = getEnvironmentPhase(build);
  const statusMessage = phase === 'failed' ? safeText(build.statusMessage) : undefined;
  const sourceBranch = getBuildSource(build).branchName;
  const expiresAt = normalizeMcpDateTime(build.expiresAt);
  const lifecycleUiUrl = buildLifecycleUiEnvironmentUrl(build.uuid);

  const base: McpEnvironmentDto = {
    format,
    uuid: build.uuid,
    environmentId: Number(build.id),
    ...(lifecycleUiUrl ? { lifecycleUiUrl } : {}),
    status: build.status,
    phase,
    ...(statusMessage ? { statusMessage } : {}),
    repository: safeLabel(options.repository, 140),
    branch: safeLabel(sourceBranch, 255),
    trigger: build.triggerType === 'api' ? 'api' : 'github_pr',
    isStatic: build.isStatic === true,
    deployEnabled: isDeployEnabled(build),
    autoTrack: build.autoTrack === true,
    ...(expiresAt ? { expiresAt } : {}),
    ready: isEnvironmentReady(build),
    ...(build.runUUID ? { currentDeployId: build.runUUID } : {}),
    services: bounded.deploys.map((deploy) => serviceDto(deploy, format === 'detailed')),
    servicesTruncated: bounded.truncated,
    failingServices,
  };

  if (format === 'detailed') {
    return {
      ...base,
      ...(build.configSha ? { configSha: build.configSha } : {}),
      trackDefaultBranches: build.trackDefaultBranches === true,
      namespace: build.namespace,
      ...(build.createdByGithubLogin ? { createdBy: safeLabel(build.createdByGithubLogin, 255) } : {}),
      envKeys: safeEnvironmentKeys(build.commentRuntimeEnv),
      initEnvKeys: safeEnvironmentKeys(build.commentInitEnv),
    };
  }
  return base;
}
