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
import { assertBuildRepositoryAllowed } from 'server/lib/repositoryAuthorization';
import { successResponse } from 'server/lib/response';
import { AppError, NotFoundError } from 'server/lib/appError';
import BuildService from 'server/services/build';
import OverrideService from 'server/services/override';
import { BuildKind } from 'shared/constants';
import { assertNoUnknownFields } from '../../me/tokens/shared';
import {
  assertJsonObject,
  ENVIRONMENT_PATCH_FIELDS,
  parseOptionalBoolean,
  parseOptionalServices,
  parseOptionalStringMap,
} from '../requestValidation';

/**
 * @openapi
 * /api/v2/environments/{uuid}:
 *   get:
 *     summary: Get environment detail
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: Full environment state including per-service status; poll this to a terminal status.
 *     tags: [Environments]
 *     operationId: getEnvironment
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: Environment detail.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentDetailSuccessResponse' }
 *       '404': { description: Environment not found (env_not_found). }
 *   patch:
 *     summary: Update environment configuration
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Applies config overrides on top of lifecycle.yaml via the same override
 *       machinery PR comments and the UI use. Secret references are rejected in
 *       env values. Optionally pauses/resumes deploys via deployEnabled.
 *     tags: [Environments]
 *     operationId: patchEnvironment
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               services:
 *                 type: array
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
 *               deployEnabled: { type: boolean }
 *               autoTrack: { type: boolean }
 *               trackDefaultBranches: { type: boolean }
 *     responses:
 *       '200':
 *         description: Updated environment detail.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentDetailSuccessResponse' }
 *       '400': { description: Invalid request body (invalid_body). }
 *       '404': { description: Environment not found. }
 *       '409': { description: Teardown already owns the environment (env_tearing_down). }
 *       '422': { description: Invalid override, or autoTrack on an immutable source (auto_track_pinned_source). }
 *   delete:
 *     summary: Destroy an environment
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Queues teardown. Poll the detail endpoint while it returns 200; a 404 means teardown
 *       completed and the record was released, freeing the name for reuse.
 *     tags: [Environments]
 *     operationId: deleteEnvironment
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '202':
 *         description: Teardown queued.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnvironmentQueuedOperationSuccessResponse' }
 *       '404': { description: Environment not found. }
 *       '409': { description: Static environments cannot be destroyed (env_static_protected). }
 */
const getHandler = createPrincipalApiHandler(
  { scope: 'env:read' },
  async (req: NextRequest, principal, ctx: { params: Promise<{ uuid: string }> }) => {
    const { uuid } = await ctx.params;
    const buildService = new BuildService();
    const build = await buildService.db.models.Build.query()
      .findOne({ uuid })
      .where('kind', BuildKind.ENVIRONMENT)
      .whereNull('deletedAt')
      .withGraphFetched('pullRequest');
    if (!build) {
      throw new NotFoundError(`Environment ${uuid} was not found.`, 'env_not_found');
    }
    await assertBuildRepositoryAllowed(principal, build);

    const detail = await buildService.getEnvironmentDetail(uuid, build.id);
    if (!detail) {
      throw new NotFoundError(`Environment ${uuid} was not found.`, 'env_not_found');
    }
    return successResponse(detail, { status: 200 }, req);
  }
);

const patchHandler = createPrincipalApiHandler(
  { scope: 'env:write' },
  async (req: NextRequest, principal, ctx: { params: Promise<{ uuid: string }> }) => {
    const { uuid } = await ctx.params;
    const body: unknown = await req.json().catch(() => null);
    assertJsonObject(body);
    assertNoUnknownFields(body, ENVIRONMENT_PATCH_FIELDS);
    const services = parseOptionalServices(body);
    const deployEnabled = parseOptionalBoolean(body, 'deployEnabled');
    const autoTrack = parseOptionalBoolean(body, 'autoTrack');
    const trackDefaultBranches = parseOptionalBoolean(body, 'trackDefaultBranches');
    const env = parseOptionalStringMap(body, 'env');
    const initEnv = parseOptionalStringMap(body, 'initEnv');

    const buildService = new BuildService();
    const override = new OverrideService();
    const build = await override.db.models.Build.query()
      .findOne({ uuid })
      .where('kind', BuildKind.ENVIRONMENT)
      .whereNull('deletedAt')
      .withGraphFetched('[pullRequest, deploys.[deployable]]');
    if (!build) {
      throw new NotFoundError(`Environment ${uuid} was not found.`, 'env_not_found');
    }
    await assertBuildRepositoryAllowed(principal, build);
    if (autoTrack === true && build.configSha) {
      throw new AppError({
        httpStatus: 422,
        code: 'auto_track_pinned_source',
        message: 'autoTrack cannot be enabled for an environment pinned to an immutable source revision.',
      });
    }

    await buildService.applyApiEnvironmentPatch(build, override, {
      services: services ?? null,
      env: env ?? null,
      initEnv: initEnv ?? null,
      deployEnabled,
      autoTrack,
      trackDefaultBranches,
    });

    const detail = await buildService.getEnvironmentDetail(uuid, build.id);
    if (!detail) {
      throw new NotFoundError(`Environment ${uuid} was not found.`, 'env_not_found');
    }
    return successResponse(detail, { status: 200 }, req);
  }
);

const deleteHandler = createPrincipalApiHandler(
  { scope: 'env:write' },
  async (req: NextRequest, principal, ctx: { params: Promise<{ uuid: string }> }) => {
    const { uuid } = await ctx.params;
    const buildService = new BuildService();
    const build = await buildService.db.models.Build.query()
      .findOne({ uuid })
      .where('kind', BuildKind.ENVIRONMENT)
      .whereNull('deletedAt')
      .withGraphFetched('pullRequest');
    if (!build) {
      throw new NotFoundError(`Environment ${uuid} was not found.`, 'env_not_found');
    }
    await assertBuildRepositoryAllowed(principal, build);
    if (build.isStatic) {
      throw new AppError({
        httpStatus: 409,
        code: 'env_static_protected',
        message: 'Static environments cannot be destroyed through the environments API.',
      });
    }

    const claimedBuild = await buildService.requestApiEnvironmentDeletion(uuid, build.id);
    return successResponse(
      {
        uuid: claimedBuild.uuid,
        status: 'tearing_down_queued',
        statusUrl: `/api/v2/environments/${claimedBuild.uuid}`,
      },
      { status: 202 },
      req
    );
  }
);

export const GET = getHandler;
export const PATCH = patchHandler;
export const DELETE = deleteHandler;
