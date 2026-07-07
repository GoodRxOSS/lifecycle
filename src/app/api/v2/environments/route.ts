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
import { getPaginationParamsFromURL } from 'server/lib/paginate';
import { successResponse } from 'server/lib/response';
import { AppError, BadRequestError } from 'server/lib/appError';
import BuildService from 'server/services/build';
import { assertNoUnknownFields } from '../me/tokens/shared';
import {
  assertJsonObject,
  ENVIRONMENT_CREATE_FIELDS,
  parseOptionalBoolean,
  parseOptionalNullableString,
  parseOptionalPositiveInteger,
  parseOptionalServices,
  parseOptionalStringMap,
} from './requestValidation';

/**
 * @openapi
 * /api/v2/environments:
 *   get:
 *     summary: List environments
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Shallow, paginated listing of environments (webhook- and API-created).
 *       A row with deletedAt is list-only history: UUID resource routes resolve only a live
 *       environment and may resolve a newer environment if that UUID has been reused.
 *       Requires an API token with env:read (or a Keycloak user when auth is enabled).
 *     tags:
 *       - Environments
 *     operationId: listEnvironments
 *     parameters:
 *       - in: query
 *         name: exclude
 *         schema: { type: string, example: "torn_down" }
 *         description: Comma-separated statuses to exclude (default torn_down). Allowing torn_down by omitting it from this list also returns list-only deleted environment history.
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: trigger
 *         schema: { type: string, enum: [api, github_pr] }
 *       - in: query
 *         name: mine
 *         schema: { type: boolean }
 *         description: Only environments created by this token (or user).
 *       - in: query
 *         name: hasReadyActiveService
 *         schema: { type: boolean }
 *         description: Filter before pagination by whether an environment has at least one active, ready, named service.
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 25 }
 *     responses:
 *       '200':
 *         description: Paginated environment summaries.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentListSuccessResponse' }
 *       '401': { description: Missing or invalid credentials. }
 *       '403': { description: Missing env:read scope. }
 *   post:
 *     summary: Create an environment
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Creates an ephemeral environment from a repository + branch without a pull
 *       request. lifecycle.yaml at the target ref is the environment definition.
 *       Returns 202 with the environment uuid; poll GET /api/v2/environments/{uuid}
 *       until a terminal status (deployed | error | config_error | torn_down).
 *       Requires env:write and the api_environments global config to be enabled.
 *     tags:
 *       - Environments
 *     operationId: createEnvironment
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [repository, branch]
 *             additionalProperties: false
 *             properties:
 *               repository: { type: string, example: "org/repo" }
 *               branch: { type: string, example: "main" }
 *               sha: { type: string, nullable: true, description: "Pin lifecycle.yaml and service builds to a commit." }
 *               environmentId: { type: integer, minimum: 1, maximum: 9007199254740991, nullable: true }
 *               name: { type: string, nullable: true, description: "Vanity uuid/subdomain (dns-safe)." }
 *               services:
 *                 type: array
 *                 nullable: true
 *                 items:
 *                   type: object
 *                   required: [name]
 *                   additionalProperties: false
 *                   properties:
 *                     name: { type: string }
 *                     active: { type: boolean }
 *                     branchOrExternalUrl: { type: string }
 *               env: { type: object, additionalProperties: { type: string } }
 *               initEnv: { type: object, additionalProperties: { type: string } }
 *               deployEnabled: { type: boolean, default: true }
 *               trackDefaultBranches: { type: boolean, default: false }
 *               autoTrack: { type: boolean, default: false, description: "Redeploy on pushes to the source branch." }
 *               ttlHours: { type: integer, minimum: 1, maximum: 9007199254740991, nullable: true }
 *               idempotencyKey: { type: string, nullable: true, description: "Replaying the same key returns the existing environment." }
 *     responses:
 *       '202':
 *         description: Environment accepted for asynchronous creation.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentCreateSuccessResponse' }
 *       '200':
 *         description: Idempotent replay of an existing environment.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentCreateSuccessResponse' }
 *       '400': { description: Invalid body or ambiguous environment (env_ambiguous). }
 *       '403': { description: Missing scope, repository not allowed for token, or api_environments disabled. }
 *       '404': { description: Repository not onboarded (repo_not_onboarded). }
 *       '409': { description: Vanity name already taken (name_conflict). }
 *       '422': { description: Invalid config/override, or autoTrack with an immutable sha (auto_track_pinned_source). }
 */
const getHandler = createPrincipalApiHandler({ scope: 'env:read' }, async (req: NextRequest, principal) => {
  const { searchParams } = req.nextUrl;
  const buildService = new BuildService();
  const mine = searchParams.get('mine') === 'true';
  const readyServiceParam = searchParams.get('hasReadyActiveService');
  if (readyServiceParam != null && readyServiceParam !== 'true' && readyServiceParam !== 'false') {
    throw new BadRequestError('hasReadyActiveService must be true or false.', 'invalid_query');
  }
  const hasReadyActiveService = readyServiceParam == null ? null : readyServiceParam === 'true';
  const isHuman = principal.userId != null;
  // mine keys on the owner sub (present for both human kinds), not github — a null-github user still sees their envs.
  if (mine && !isHuman && principal.kind !== 'service_key') {
    throw new BadRequestError(
      'mine=true requires an authenticated identity (or an API token).',
      'mine_requires_identity'
    );
  }

  const { data, paginationMetadata } = await buildService.listEnvironments({
    excludeStatuses: searchParams.get('exclude'),
    search: searchParams.get('search'),
    trigger: searchParams.get('trigger'),
    hasReadyActiveService,
    createdByTokenId: mine && principal.kind === 'service_key' ? principal.tokenId : null,
    ownerUserId: mine && isHuman ? principal.userId : null,
    githubLogin: mine && isHuman ? principal.identity?.githubUsername ?? null : null,
    repositoryAllowlist: principal.repositoryAllowlist,
    repositoryAllowlistRepoIds: principal.repositoryAllowlistRepoIds,
    pagination: getPaginationParamsFromURL(searchParams),
  });

  return successResponse(data, { metadata: { pagination: paginationMetadata }, status: 200 }, req);
});

const postHandler = createPrincipalApiHandler({ scope: 'env:write' }, async (req: NextRequest, principal) => {
  const body: unknown = await req.json().catch(() => null);
  assertJsonObject(body);
  assertNoUnknownFields(body, ENVIRONMENT_CREATE_FIELDS);
  if (typeof body.repository !== 'string' || typeof body.branch !== 'string') {
    throw new BadRequestError('repository and branch are required strings', 'invalid_body');
  }
  const services = parseOptionalServices(body, { nullable: true });
  const ttlHours = parseOptionalPositiveInteger(body, 'ttlHours', { nullable: true });
  const environmentId = parseOptionalPositiveInteger(body, 'environmentId', { nullable: true });
  const name = parseOptionalNullableString(body, 'name');
  const sha = parseOptionalNullableString(body, 'sha');
  const idempotencyKey = parseOptionalNullableString(body, 'idempotencyKey');
  const deployEnabled = parseOptionalBoolean(body, 'deployEnabled');
  const trackDefaultBranches = parseOptionalBoolean(body, 'trackDefaultBranches');
  const autoTrack = parseOptionalBoolean(body, 'autoTrack');
  const env = parseOptionalStringMap(body, 'env');
  const initEnv = parseOptionalStringMap(body, 'initEnv');
  if (sha && autoTrack === true) {
    throw new AppError({
      httpStatus: 422,
      code: 'auto_track_pinned_source',
      message: 'autoTrack cannot be enabled when sha pins the environment to an immutable source revision.',
    });
  }

  await assertNamedRepositoryAllowed(principal, body.repository);

  const buildService = new BuildService();
  const { build, replayed } = await buildService.createApiEnvironment(
    {
      repositoryFullName: body.repository,
      branch: body.branch,
      sha: sha ?? null,
      environmentId: environmentId ?? null,
      name: name ?? null,
      services: services ?? null,
      env: env ?? null,
      initEnv: initEnv ?? null,
      deployEnabled: deployEnabled ?? true,
      trackDefaultBranches: trackDefaultBranches ?? false,
      autoTrack: autoTrack ?? false,
      ttlHours: ttlHours ?? null,
      idempotencyKey: idempotencyKey || null,
      createdByTokenId: principal.tokenId,
      createdBy: principal.actor,
      createdByUserId: principal.userId,
      createdByGithubLogin: principal.identity?.githubUsername ?? null,
    },
    principal.repositoryAllowlistRepoIds
  );

  return successResponse(
    {
      uuid: build.uuid,
      status: build.status,
      namespace: build.namespace,
      expiresAt: build.expiresAt ?? null,
      statusUrl: `/api/v2/environments/${build.uuid}`,
      replayed,
    },
    { status: replayed ? 200 : 202 },
    req
  );
});

export const GET = getHandler;
export const POST = postHandler;
