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

// The single build-source/deploy-gate accessor: direct `build.pullRequest?.x ?? build.x` dual-reads are forbidden outside this module (buildSourceGate.test.ts).

import type Build from 'server/models/Build';
import type PullRequest from 'server/models/PullRequest';
import type Repository from 'server/models/Repository';
import { getLogger } from 'server/lib/logger';

export interface BuildSourceRef {
  /** 'org/repo' of the repository the environment is defined by (lifecycle.yaml source). */
  fullName: string | null;
  branchName: string | null;
  githubRepositoryId: number | null;
  /** Pinned lifecycle.yaml ref for API builds; null tracks the branch tip like webhook builds. */
  configSha: string | null;
  pullRequest: PullRequest | null;
}

const SHADOW_COMPARE_SAMPLE_RATE = 0.01;

function shadowCompare(build: Build, pullRequest: PullRequest): void {
  if (build.branchName == null && build.githubRepositoryId == null) return;
  if (Math.random() > SHADOW_COMPARE_SAMPLE_RATE) return;

  const divergences: string[] = [];
  if (build.branchName != null && build.branchName !== pullRequest.branchName) {
    divergences.push(`branchName build=${build.branchName} pr=${pullRequest.branchName}`);
  }
  if (
    build.githubRepositoryId != null &&
    pullRequest.repository?.githubRepositoryId != null &&
    Number(build.githubRepositoryId) !== Number(pullRequest.repository.githubRepositoryId)
  ) {
    divergences.push(
      `githubRepositoryId build=${build.githubRepositoryId} pr=${pullRequest.repository.githubRepositoryId}`
    );
  }
  if (divergences.length > 0) {
    getLogger({ buildUuid: build.uuid }).warn(`BuildSource: shadow-compare divergence ${divergences.join(' ')}`);
  }
}

/** For builds with a PullRequest row the returned values are exactly the legacy pipeline reads. */
export function getBuildSource(build: Build): BuildSourceRef {
  const pullRequest = build.pullRequest ?? null;

  if (pullRequest) {
    shadowCompare(build, pullRequest);
    return {
      fullName: pullRequest.fullName ?? null,
      branchName: pullRequest.branchName ?? null,
      githubRepositoryId:
        pullRequest.repository?.githubRepositoryId != null ? Number(pullRequest.repository.githubRepositoryId) : null,
      configSha: null,
      pullRequest,
    };
  }

  return {
    fullName: null,
    branchName: build.branchName ?? null,
    githubRepositoryId: build.githubRepositoryId != null ? Number(build.githubRepositoryId) : null,
    configSha: build.configSha ?? null,
    pullRequest: null,
  };
}

export function isDeployEnabled(build: Build): boolean {
  if (build.pullRequest) {
    return build.pullRequest.deployOnUpdate;
  }
  return build.deployEnabled === true;
}

/** PR builds reuse the loaded pullRequest.repository; PR-less builds look it up by builds.githubRepositoryId. */
export async function resolveBuildSourceRepository(build: Build): Promise<Repository | null> {
  if (build.pullRequest) {
    if (!build.pullRequest.repository) {
      await build.pullRequest.$fetchGraph('[repository]');
    }
    return build.pullRequest.repository ?? null;
  }

  if (build.githubRepositoryId == null) {
    return null;
  }

  const { Repository: RepositoryModel } = await import('server/models');
  const repository = await RepositoryModel.query()
    .findOne({ githubRepositoryId: Number(build.githubRepositoryId) })
    .whereNull('deletedAt');
  return repository ?? null;
}
