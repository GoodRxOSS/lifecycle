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
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import RepositoryService from 'server/services/repository';

/**
 * @openapi
 * /api/v2/repositories:
 *   get:
 *     summary: List repositories
 *     description: >
 *       Lists Lifecycle-onboarded repositories by default. Pass view=all to list
 *       repositories accessible to the configured GitHub App installation with
 *       Lifecycle onboarding status annotated.
 *     tags:
 *       - Repositories
 *     operationId: listRepositories
 *     parameters:
 *       - in: query
 *         name: view
 *         schema:
 *           type: string
 *           enum: [onboarded, all]
 *           default: onboarded
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Case-insensitive repository search query.
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 25
 *           minimum: 1
 *           maximum: 100
 *       - in: query
 *         name: onboarded
 *         schema:
 *           type: boolean
 *         description: Only supported with view=all.
 *       - in: query
 *         name: refresh
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Bypass the installed GitHub repositories cache for view=all.
 *     responses:
 *       '200':
 *         description: Matching repositories.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListRepositoriesSuccessResponse'
 *       '400':
 *         description: Invalid query parameter.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Onboard a repository
 *     description: >
 *       Adds a GitHub repository to Lifecycle's repository allowlist. The repository
 *       must be accessible to the configured GitHub App installation. If the row
 *       already exists or was soft-deleted, Lifecycle refreshes the stored repository
 *       metadata and marks it active.
 *     tags:
 *       - Repositories
 *     operationId: onboardRepository
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/OnboardRepositoryRequest'
 *     responses:
 *       '200':
 *         description: Existing repository refreshed and onboarded.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OnboardRepositorySuccessResponse'
 *       '201':
 *         description: Repository onboarded.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OnboardRepositorySuccessResponse'
 *       '400':
 *         description: Invalid request body.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Repository not found or unavailable to the GitHub App.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const service = new RepositoryService();
  const view = req.nextUrl.searchParams.get('view') || 'onboarded';
  const query = req.nextUrl.searchParams.get('q') || '';
  const page = Number.parseInt(req.nextUrl.searchParams.get('page') || '1', 10);
  const limit = Number.parseInt(req.nextUrl.searchParams.get('limit') || '25', 10);
  const refresh = req.nextUrl.searchParams.get('refresh') === 'true';
  const rawInstallationId = req.nextUrl.searchParams.get('installationId');
  const installationId = rawInstallationId ? Number(rawInstallationId) : undefined;

  if (rawInstallationId && !Number.isFinite(installationId)) {
    return errorResponse(new Error('installationId must be a number'), { status: 400 }, req);
  }

  if (view === 'all') {
    let onboarded: boolean | undefined;
    try {
      onboarded = service.parseOnboardedParam(req.nextUrl.searchParams.get('onboarded'));
    } catch (error) {
      return errorResponse(error, { status: 400 }, req);
    }

    const result = await service.listInstalledRepositories({
      query,
      page,
      limit,
      installationId,
      onboarded,
      refresh,
    });

    return successResponse(
      { repositories: result.repositories },
      { status: 200, metadata: { pagination: result.pagination } },
      req
    );
  }

  if (view !== 'onboarded') {
    return errorResponse(new Error('view must be onboarded or all'), { status: 400 }, req);
  }

  const result = await service.listOnboardedRepositories({
    query,
    page,
    limit,
    installationId,
  });

  return successResponse(
    { repositories: result.repositories },
    { status: 200, metadata: { pagination: result.pagination } },
    req
  );
};

const postHandler = async (req: NextRequest) => {
  let body: { fullName?: unknown; repository?: unknown; installationId?: unknown; githubInstallationId?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const fullName = body.fullName ?? body.repository;
  if (typeof fullName !== 'string' || !fullName.trim()) {
    return errorResponse(new Error('Missing required field: fullName'), { status: 400 }, req);
  }

  const rawInstallationId = body.installationId ?? body.githubInstallationId;
  const installationId =
    rawInstallationId === undefined || rawInstallationId === null ? undefined : Number(rawInstallationId);

  if (installationId !== undefined && !Number.isFinite(installationId)) {
    return errorResponse(new Error('installationId must be a number'), { status: 400 }, req);
  }

  try {
    const result = await new RepositoryService().onboardRepository(fullName, installationId);
    return successResponse(result, { status: result.created ? 201 : 200 }, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Invalid repository fullName') || message.includes('installation ID is required')) {
      return errorResponse(error, { status: 400 }, req);
    }
    if (message.includes('Repository not found')) {
      return errorResponse(error, { status: 404 }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
