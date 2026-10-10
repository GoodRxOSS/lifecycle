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

import { isDeployEnabled } from 'server/lib/buildSource';
import type Build from 'server/models/Build';
import type Deploy from 'server/models/Deploy';
import { BuildStatus, PullRequestStatus } from 'shared/constants';

export type EnvironmentBlockReason =
  | 'build_missing'
  | 'build_deleted'
  | 'tearing_down'
  | 'pull_request_missing'
  | 'pull_request_closed'
  | 'deploy_disabled'
  | 'torn_down';

export interface AuthorityModels {
  Build: typeof Build;
  Deploy: typeof Deploy;
}

/** Why no deployment work may run for this environment right now, or null. */
export function environmentBlockReason(build: Build | null | undefined): EnvironmentBlockReason | null {
  if (!build) return 'build_missing';
  if (build.deletedAt != null) return 'build_deleted';

  if (build.pullRequest || build.pullRequestId != null) {
    if (build.status === BuildStatus.TEARING_DOWN) return 'tearing_down';
    if (!build.pullRequest) return 'pull_request_missing';
    if (build.pullRequest.status !== PullRequestStatus.OPEN) return 'pull_request_closed';
    if (!isDeployEnabled(build)) return 'deploy_disabled';
    // Re-adding the deploy label to an open PR may reclaim the row after teardown completes.
    return null;
  }

  if (build.status === BuildStatus.TEARING_DOWN || build.status === BuildStatus.TORN_DOWN) return 'torn_down';
  return build.deployEnabled === true ? null : 'deploy_disabled';
}

export async function loadEnvironmentAuthority(models: AuthorityModels, buildId: number): Promise<Build | null> {
  const build = await models.Build.query()
    .findById(buildId)
    .select('id', 'runUUID', 'status', 'deployEnabled', 'deletedAt', 'pullRequestId', 'desiredGeneration');
  if (build?.pullRequestId != null) await build.$fetchGraph('pullRequest');
  return build ?? null;
}

export async function isEnvironmentUnblocked(models: AuthorityModels, buildId: number): Promise<boolean> {
  return environmentBlockReason(await loadEnvironmentAuthority(models, buildId)) == null;
}

/** The row is still owned by this run, still desired at this generation, and not yet marked finished. */
export async function isDeployOwnedByRun(
  models: AuthorityModels,
  deployId: number,
  runUUID: string,
  expectedGeneration?: number
): Promise<boolean> {
  const owned = await models.Deploy.query()
    .findOne({
      id: deployId,
      runUUID,
      ...(expectedGeneration != null ? { desiredGeneration: expectedGeneration } : {}),
    })
    .select('id', 'observedGeneration');
  if (!owned) return false;
  if (expectedGeneration == null || owned.observedGeneration == null) return true;
  return Number(owned.observedGeneration) < expectedGeneration;
}

/**
 * The one authority predicate for service work. Nothing about other services
 * appears in it: a newer intent that selects this row changes the row itself.
 */
export async function isDeployAuthorityCurrent(
  models: AuthorityModels,
  deploy: Pick<Deploy, 'id' | 'buildId'>,
  runUUID: string,
  expectedGeneration?: number
): Promise<boolean> {
  if (!(await isDeployOwnedByRun(models, deploy.id, runUUID, expectedGeneration))) return false;
  return expectedGeneration == null || isEnvironmentUnblocked(models, deploy.buildId);
}

/** An intent stays current while it still owns at least one row at its generation. */
export async function isIntentRunCurrent(
  models: AuthorityModels,
  buildId: number,
  runUUID: string,
  expectedGeneration: number
): Promise<boolean> {
  const owned = await models.Deploy.query()
    .findOne({ buildId, runUUID, desiredGeneration: expectedGeneration })
    .select('id');
  if (!owned) return false;
  return isEnvironmentUnblocked(models, buildId);
}
