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

import type { PartialModelObject, QueryBuilder, Transaction } from 'objection';
import type { JobDataWithContext } from 'server/lib/logger';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { DeployStatus } from 'shared/constants';

export interface SourcePushIntent {
  type: 'source';
  requestId: string;
  /** A root/config source can intentionally request a full Environment pass. */
  target: 'repository' | 'all';
  githubRepositoryId: number;
  branch: string;
  sha: string;
  /** Delivered push predecessor; used to recognize a temporarily stale branch-head read. */
  beforeSha?: string;
  /** Services whose push-ignore policy matched every changed file; their healthy rows keep the current image. */
  skipServices?: string[];
}

export interface RepositoryRedeployIntent {
  type: 'repository';
  requestId: string;
  githubRepositoryId: number;
}

export interface EnvironmentRedeployIntent {
  type: 'all';
  requestId: string;
}

export type DeploymentIntent = SourcePushIntent | RepositoryRedeployIntent | EnvironmentRedeployIntent;
export type AcceptedDeploymentIntent = DeploymentIntent & {
  gen: number;
  observedGen?: number;
  /** Services whose YAML failed in this intent's import and had no row to carry it; absent until the import ran. */
  configFailures?: Record<string, string>;
};
export type AcceptedDeploymentRefs = Record<string, AcceptedDeploymentIntent>;

export interface DeploymentReconciliationJobData extends JobDataWithContext {
  buildId: number;
  /** The exact desired generation that caused this reconciliation signal. */
  generation: number;
}

export interface ReplacedDeploymentIntent {
  requestId: string;
  generation: number;
}

export interface AcceptDeploymentIntentResult {
  accepted: boolean;
  generation: number;
  scopeKey: string;
  /** Pending requests this acceptance retired; a run already under way stops at its next ownership check. */
  replaced: ReplacedDeploymentIntent[];
}

/** A stable key lets a newer intent replace only earlier work for the same scope. */
export function deploymentIntentScopeKey(intent: DeploymentIntent): string {
  switch (intent.type) {
    case 'source':
      // A config-repo push selects every row; it must never replace the repo-scoped entry of the same source.
      return `source:${intent.githubRepositoryId}:${encodeURIComponent(intent.branch)}${
        intent.target === 'all' ? ':all' : ''
      }`;
    case 'repository':
      return `repository:${intent.githubRepositoryId}`;
    case 'all':
      return 'all';
  }
}

export function deploymentIntentSelectsAllDeploys(intent: DeploymentIntent): boolean {
  return intent.type === 'all' || (intent.type === 'source' && intent.target === 'all');
}

/** The Deploy rows an intent selects; an empty filter means every active row. */
export function deploymentIntentDeployFilter(intent: DeploymentIntent): {
  githubRepositoryId?: number;
  branchName?: string;
} {
  if (intent.type === 'all') return {};
  if (intent.type === 'source') {
    return intent.target === 'all' ? {} : { githubRepositoryId: intent.githubRepositoryId, branchName: intent.branch };
  }
  return { githubRepositoryId: intent.githubRepositoryId };
}

const SKIPPABLE_DEPLOY_STATUSES = [DeployStatus.READY, DeployStatus.DEPLOYED, DeployStatus.BUILT];

/**
 * Leaves out rows of the intent's skipped services that are settled and healthy. A row that is still pending
 * (including one a replaced intent stamped), failed, or never deployed stays selected.
 */
export function excludeSkippedServiceDeploys<QB extends QueryBuilder<Deploy, any>>(
  query: QB,
  buildId: number,
  intent: DeploymentIntent,
  trx?: Transaction
): QB {
  if (intent.type !== 'source' || intent.target !== 'repository' || !intent.skipServices?.length) return query;
  return query.whereNotIn(
    'id',
    Deploy.query(trx)
      .select('deploys.id')
      .join('deployables', 'deployables.id', 'deploys.deployableId')
      .where('deploys.buildId', buildId)
      .whereIn('deployables.name', intent.skipServices)
      .whereIn('deploys.status', SKIPPABLE_DEPLOY_STATUSES)
      .whereRaw('?? >= ??', ['deploys.observedGeneration', 'deploys.desiredGeneration'])
  );
}

/** A stamped row is unowned and queued: the older run can no longer write to it, and its old status is not current. */
export function deployStampForGeneration(generation: number): PartialModelObject<Deploy> {
  const stamp = { desiredGeneration: generation, runUUID: null, status: DeployStatus.QUEUED, statusMessage: null };
  // The token column is nullable; the model types it as a string.
  return stamp as unknown as PartialModelObject<Deploy>;
}

/** Raises the selected rows to `generation`; rows already desired at a newer generation are left alone. */
export async function stampDeploysForIntent(
  trx: Transaction | undefined,
  buildId: number,
  intent: DeploymentIntent,
  generation: number
): Promise<number> {
  return excludeSkippedServiceDeploys(
    Deploy.query(trx)
      .patch(deployStampForGeneration(generation))
      .where({ buildId, active: true, ...deploymentIntentDeployFilter(intent) })
      .where('desiredGeneration', '<', generation),
    buildId,
    intent,
    trx
  );
}

/**
 * Atomically records desired work. The Build row lock serializes concurrent
 * accepters; the JSON map coalesces repeated work without becoming a queue.
 */
export async function acceptDeploymentIntent(
  buildId: number,
  intent: DeploymentIntent
): Promise<AcceptDeploymentIntentResult | null> {
  return Build.transact(async (trx) => {
    const build = await Build.query(trx)
      .select('id', 'desiredGeneration', 'acceptedRefs')
      .findById(buildId)
      .whereNull('deletedAt')
      .forUpdate();

    if (!build) return null;

    const scopeKey = deploymentIntentScopeKey(intent);
    const acceptedRefs =
      build.acceptedRefs && typeof build.acceptedRefs === 'object' && !Array.isArray(build.acceptedRefs)
        ? build.acceptedRefs
        : {};
    const previous = acceptedRefs[scopeKey];
    const desiredGeneration = Number(build.desiredGeneration);

    if (!Number.isSafeInteger(desiredGeneration) || desiredGeneration < 0) {
      throw new Error(`Build ${buildId} has an invalid desired generation`);
    }

    if (
      previous?.requestId === intent.requestId ||
      (intent.type === 'source' &&
        previous?.type === 'source' &&
        previous.sha === intent.sha &&
        previous.target === intent.target)
    ) {
      return { accepted: false, generation: desiredGeneration, scopeKey, replaced: [] };
    }

    // GitHub can deliver adjacent pushes out of order. If C is already desired,
    // a delayed B identifies itself as C's predecessor and must not replace C.
    // A real rollback from C to B remains valid because its `before` is C.
    if (
      intent.type === 'source' &&
      previous?.type === 'source' &&
      previous.beforeSha &&
      intent.sha === previous.beforeSha &&
      intent.beforeSha !== previous.sha
    ) {
      return { accepted: false, generation: desiredGeneration, scopeKey, replaced: [] };
    }

    const generation = desiredGeneration + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error(`Build ${buildId} exhausted the safe generation range`);
    }

    const replaced: ReplacedDeploymentIntent[] = [];
    if (previous?.requestId && previous.observedGen !== previous.gen) {
      replaced.push({ requestId: previous.requestId, generation: previous.gen });
    }
    const nextRefs: AcceptedDeploymentRefs = {
      ...acceptedRefs,
      [scopeKey]: { ...intent, gen: generation },
    };
    // Every row moves to this generation, so an older environment-wide entry has nothing left to execute.
    if (deploymentIntentSelectsAllDeploys(intent)) {
      for (const [key, accepted] of Object.entries(acceptedRefs)) {
        if (key === scopeKey || !deploymentIntentSelectsAllDeploys(accepted) || accepted.observedGen === accepted.gen) {
          continue;
        }
        nextRefs[key] = { ...accepted, observedGen: accepted.gen };
        replaced.push({ requestId: accepted.requestId, generation: accepted.gen });
      }
    }

    await Build.query(trx).findById(buildId).patch({
      desiredGeneration: generation,
      acceptedRefs: nextRefs,
    });
    await stampDeploysForIntent(trx, buildId, intent, generation);

    return { accepted: true, generation, scopeKey, replaced };
  });
}

/** Records which row-less services the import at `generation` could not read; an empty map means the import was clean. */
export async function recordIntentConfigFailures(
  buildId: number,
  generation: number,
  configFailures: Record<string, string>
): Promise<boolean> {
  return Build.transact(async (trx) => {
    const build = await Build.query(trx)
      .select('id', 'acceptedRefs')
      .findById(buildId)
      .whereNull('deletedAt')
      .forUpdate();
    if (!build) return false;

    const acceptedRefs =
      build.acceptedRefs && typeof build.acceptedRefs === 'object' && !Array.isArray(build.acceptedRefs)
        ? build.acceptedRefs
        : {};
    const entry = Object.entries(acceptedRefs).find(([, intent]) => intent?.gen === generation);
    if (!entry) return false;
    const [scopeKey, intent] = entry;

    await Build.query(trx)
      .findById(buildId)
      .patch({ acceptedRefs: { ...acceptedRefs, [scopeKey]: { ...intent, configFailures } } });
    return true;
  });
}
