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
 * /api/v2/environments/config-preview:
 *   get:
 *     summary: Preview the lifecycle.yaml services for a repo + branch
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Create-environment UI helper. Parses lifecycle.yaml at the ref and returns one service row per
 *       environment entry with its default-active state and whether a branch/URL override is editable
 *       (github/helm/externalHTTP). When api_environments is enabled, entries referencing another
 *       repository resolve against that repository's lifecycle.yaml. Requires env:read.
 *     tags: [Environments]
 *     operationId: previewEnvironmentConfig
 *     parameters:
 *       - in: query
 *         name: repository
 *         required: true
 *         schema: { type: string, example: "org/repo" }
 *       - in: query
 *         name: branch
 *         required: true
 *         schema: { type: string, example: "main" }
 *     responses:
 *       '200':
 *         description: Parsed service preview. previewOnly services are informational and must not be sent as overrides.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentConfigPreviewSuccessResponse' }
 *       '400': { description: Missing repository/branch (invalid_body). }
 *       '403': { description: Repository not allowed for token. }
 *       '404': { description: Repository not onboarded (repo_not_onboarded). }
 */
const getHandler = createPrincipalApiHandler({ scope: 'env:read' }, async (req: NextRequest, principal) => {
  const repository = req.nextUrl.searchParams.get('repository');
  const branch = req.nextUrl.searchParams.get('branch');
  if (!repository) {
    throw new BadRequestError('repository query param is required', 'invalid_body');
  }
  if (!branch) {
    throw new BadRequestError('branch query param is required', 'invalid_body');
  }
  await assertNamedRepositoryAllowed(principal, repository);

  const result = await new BuildService().previewEnvironmentConfig(repository, branch);
  return successResponse(result, { status: 200 }, req);
});

export const GET = getHandler;
