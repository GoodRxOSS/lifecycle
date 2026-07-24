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

import { NextRequest } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import { assertNamedRepositoryAllowed } from 'server/lib/repositoryAuthorization';
import { successResponse } from 'server/lib/response';
import { BadRequestError } from 'server/lib/appError';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/environments/branches:
 *   get:
 *     summary: List branches for an onboarded repository
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Branch picker source for the create-environment UI. Returns the repository's
 *       GitHub branches (first 100) and its default branch. Requires env:read.
 *     tags: [Environments]
 *     operationId: listEnvironmentRepositoryBranches
 *     parameters:
 *       - in: query
 *         name: repository
 *         required: true
 *         schema: { type: string, example: "org/repo" }
 *     responses:
 *       '200':
 *         description: Repository branches and its default branch.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentBranchesSuccessResponse' }
 *       '400': { description: Missing repository (invalid_body). }
 *       '403': { description: Repository not allowed for token. }
 *       '404': { description: Repository not onboarded (repo_not_onboarded). }
 */
const getHandler = createPrincipalApiHandler({ scope: 'env:read' }, async (req: NextRequest, principal) => {
  const repository = req.nextUrl.searchParams.get('repository');
  if (!repository) {
    throw new BadRequestError('repository query param is required', 'invalid_body');
  }
  await assertNamedRepositoryAllowed(principal, repository);

  const result = await new BuildService().listRepositoryBranches(repository);
  return successResponse(result, { status: 200 }, req);
});

export const GET = getHandler;
