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

import { isRepositoryAllowed, isRepositoryAllowedById } from 'server/services/apiToken';
import { resolveBuildSourceRepository } from 'server/lib/buildSource';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import Repository from 'server/models/Repository';
import type Build from 'server/models/Build';
import { AppError } from './appError';
import type { Principal } from './principal';

export function assertRepositoryAllowed(principal: Principal, fullName: string): void {
  if (!isRepositoryAllowed(principal.repositoryAllowlist, fullName)) {
    throw new AppError({
      httpStatus: 403,
      code: 'forbidden_repository',
      message: `API token is not allowed to target repository ${fullName}.`,
      details: { repository: fullName },
    });
  }
}

/**
 * Allowlist gate for name-targeted routes. Id-bound tokens authorize against the resolved
 * repository's githubRepositoryId — a stored name must never authorize a different repository
 * after rename/name-reuse. Legacy name-only tokens keep string comparison.
 */
export async function assertNamedRepositoryAllowed(principal: Principal, fullName: string): Promise<void> {
  const repoIds = principal.repositoryAllowlistRepoIds;
  if (!repoIds) {
    assertRepositoryAllowed(principal, fullName);
    return;
  }
  const normalized = normalizeRepoFullName(fullName ?? '');
  const repository = normalized
    ? await Repository.query().whereRaw('lower("fullName") = ?', [normalized]).whereNull('deletedAt').first()
    : null;
  const repoId = repository?.githubRepositoryId;
  if (!isRepositoryAllowedById(repoIds, repoId != null ? Number(repoId) : null)) {
    throw new AppError({
      httpStatus: 403,
      code: 'forbidden_repository',
      message: `API token is not allowed to target repository ${fullName}.`,
      details: { repository: fullName },
    });
  }
}

/** Allowlist gate for per-environment routes: resolves the build's source repository and asserts it. */
export async function assertBuildRepositoryAllowed(principal: Principal, build: Build): Promise<void> {
  if (principal.repositoryAllowlistRepoIds) {
    let repoId = build.githubRepositoryId ?? build.pullRequest?.repository?.githubRepositoryId ?? null;
    if (repoId == null) {
      repoId = (await resolveBuildSourceRepository(build))?.githubRepositoryId ?? null;
    }
    if (!isRepositoryAllowedById(principal.repositoryAllowlistRepoIds, repoId != null ? Number(repoId) : null)) {
      throw new AppError({
        httpStatus: 403,
        code: 'forbidden_repository',
        message: 'This token is not allowed to act on this environment’s repository.',
      });
    }
    return;
  }
  if (!principal.repositoryAllowlist) return;
  const repository = build.pullRequest?.repository ?? (await resolveBuildSourceRepository(build));
  const fullName = build.pullRequest?.fullName ?? repository?.fullName;
  if (!fullName) {
    throw new AppError({
      httpStatus: 403,
      code: 'forbidden_repository',
      message: 'This repository-scoped token cannot act on an environment with no resolvable source repository.',
    });
  }
  assertRepositoryAllowed(principal, fullName);
}
