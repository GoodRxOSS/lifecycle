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

import type { JobDataWithContext } from 'server/lib/logger';
import Build from 'server/models/Build';

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
export type AcceptedDeploymentIntent = DeploymentIntent & { gen: number };
export type AcceptedDeploymentRefs = Record<string, AcceptedDeploymentIntent>;

export interface DeploymentReconciliationJobData extends JobDataWithContext {
  buildId: number;
  /** The exact desired generation that caused this reconciliation signal. */
  generation: number;
}

export interface DirtyDeploymentIntent {
  scopeKey: string;
  intent: AcceptedDeploymentIntent;
}

export interface AcceptDeploymentIntentResult {
  accepted: boolean;
  generation: number;
  scopeKey: string;
}

/** A stable key lets a newer intent replace only earlier work for the same scope. */
export function deploymentIntentScopeKey(intent: DeploymentIntent): string {
  switch (intent.type) {
    case 'source':
      return `source:${intent.githubRepositoryId}:${encodeURIComponent(intent.branch)}`;
    case 'repository':
      return `repository:${intent.githubRepositoryId}`;
    case 'all':
      return 'all';
  }
}

/** Returns the latest intent for every scope that has not yet been observed. */
export function dirtyDeploymentIntents(
  acceptedRefs: AcceptedDeploymentRefs | null | undefined,
  observedGeneration: number
): DirtyDeploymentIntent[] {
  if (!acceptedRefs || typeof acceptedRefs !== 'object' || Array.isArray(acceptedRefs)) return [];

  return Object.entries(acceptedRefs)
    .filter(([, intent]) => Number.isSafeInteger(intent?.gen) && intent.gen > observedGeneration)
    .map(([scopeKey, intent]) => ({ scopeKey, intent }))
    .sort((left, right) => left.intent.gen - right.intent.gen || left.scopeKey.localeCompare(right.scopeKey));
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
      return { accepted: false, generation: desiredGeneration, scopeKey };
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
      return { accepted: false, generation: desiredGeneration, scopeKey };
    }

    const generation = desiredGeneration + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error(`Build ${buildId} exhausted the safe generation range`);
    }

    const nextRefs: AcceptedDeploymentRefs = {
      ...acceptedRefs,
      [scopeKey]: { ...intent, gen: generation },
    };

    await Build.query(trx).findById(buildId).patch({
      desiredGeneration: generation,
      acceptedRefs: nextRefs,
    });

    return { accepted: true, generation, scopeKey };
  });
}
