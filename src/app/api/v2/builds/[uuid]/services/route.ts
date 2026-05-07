/**
 * Copyright 2026 Lifecycle contributors
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

import { nanoid } from 'nanoid';
import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import OverrideService, {
  ServiceOverrideNotFoundError,
  type ServiceOverridePatchInput,
} from 'server/services/override';

interface UpdateServiceOverridesRequest {
  serviceOverrides?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateServiceOverride(value: unknown, index: number): ServiceOverridePatchInput | Error {
  if (!isRecord(value)) {
    return new Error(`serviceOverrides[${index}] must be an object`);
  }

  const serviceName = value.serviceName;
  const hasActive = hasOwn(value, 'active');
  const hasBranchOrExternalUrl = hasOwn(value, 'branchOrExternalUrl');

  if (typeof serviceName !== 'string' || serviceName.length === 0) {
    return new Error(`serviceOverrides[${index}].serviceName must be a non-empty string`);
  }

  if (!hasActive && !hasBranchOrExternalUrl) {
    return new Error(`serviceOverrides[${index}] requires active or branchOrExternalUrl`);
  }

  if (hasActive && typeof value.active !== 'boolean') {
    return new Error(`serviceOverrides[${index}].active must be a boolean`);
  }

  if (hasBranchOrExternalUrl && typeof value.branchOrExternalUrl !== 'string') {
    return new Error(`serviceOverrides[${index}].branchOrExternalUrl must be a string`);
  }

  return {
    serviceName,
    ...(hasActive ? { active: value.active as boolean } : {}),
    ...(hasBranchOrExternalUrl ? { branchOrExternalUrl: value.branchOrExternalUrl as string } : {}),
  };
}

/**
 * @openapi
 * /api/v2/builds/{uuid}/services:
 *   patch:
 *     summary: Update service overrides in a batch
 *     description: Updates selected state and/or branch or external URL overrides for one or more services in a build.
 *     tags:
 *       - Builds
 *     operationId: updateBuildServiceOverrides
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateBuildServiceOverridesRequest'
 *     responses:
 *       '200':
 *         description: Service overrides updated.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BuildOverrideUpdateSuccessResponse'
 *       '400':
 *         description: Invalid request body.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Build or service not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const patchHandler = async (req: NextRequest, { params }: { params: { uuid: string } }) => {
  const body = (await req.json().catch(() => null)) as UpdateServiceOverridesRequest | null;
  const serviceOverridesBody = body?.serviceOverrides;

  if (!Array.isArray(serviceOverridesBody) || serviceOverridesBody.length === 0) {
    return errorResponse(new Error('serviceOverrides must be a non-empty array'), { status: 400 }, req);
  }

  const serviceOverrides: ServiceOverridePatchInput[] = [];
  for (const [index, serviceOverrideBody] of serviceOverridesBody.entries()) {
    const serviceOverride = validateServiceOverride(serviceOverrideBody, index);
    if (serviceOverride instanceof Error) {
      return errorResponse(serviceOverride, { status: 400 }, req);
    }

    serviceOverrides.push(serviceOverride);
  }

  const override = new OverrideService();
  const build = await override.db.models.Build.query()
    .findOne({ uuid: params.uuid })
    .withGraphFetched('[pullRequest, deploys.[service, deployable]]');

  if (!build) {
    return errorResponse(new Error(`Build with UUID ${params.uuid} not found`), { status: 404 }, req);
  }

  try {
    const result = await override.applyServiceOverrides({
      build,
      deploys: build.deploys || [],
      pullRequest: build.pullRequest,
      serviceOverrides,
      runUuid: nanoid(),
    });

    return successResponse(result, { status: 200 }, req);
  } catch (error) {
    if (error instanceof ServiceOverrideNotFoundError) {
      return errorResponse(error, { status: 404 }, req);
    }

    throw error;
  }
};

export const PATCH = createApiHandler(patchHandler);
