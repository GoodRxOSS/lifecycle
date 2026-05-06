import { nanoid } from 'nanoid';
import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';
import OverrideService, { BuildUuidValidationError, type BuildConfigPatchInput } from 'server/services/override';

interface UpdateBuildConfigPatchRequest {
  uuid?: unknown;
  isStatic?: unknown;
  trackDefaultBranches?: unknown;
  commentRuntimeEnv?: unknown;
  commentInitEnv?: unknown;
}

const BUILD_CONFIG_PATCH_FIELDS = ['uuid', 'isStatic', 'trackDefaultBranches', 'commentRuntimeEnv', 'commentInitEnv'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return isRecord(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateBuildConfigPatch(body: unknown): BuildConfigPatchInput | Error {
  if (!isRecord(body)) {
    return new Error('request body must be an object');
  }

  const unknownFields = Object.keys(body).filter((key) => !BUILD_CONFIG_PATCH_FIELDS.includes(key));
  if (unknownFields.length > 0) {
    return new Error(`Unsupported field(s): ${unknownFields.join(', ')}`);
  }

  if (!BUILD_CONFIG_PATCH_FIELDS.some((field) => hasOwn(body, field))) {
    return new Error('At least one build config field is required');
  }

  const patch: BuildConfigPatchInput = {};

  if (hasOwn(body, 'uuid')) {
    if (typeof body.uuid !== 'string' || body.uuid.length === 0) {
      return new Error('uuid must be a non-empty string');
    }
    patch.uuid = body.uuid;
  }

  if (hasOwn(body, 'isStatic')) {
    if (typeof body.isStatic !== 'boolean') {
      return new Error('isStatic must be a boolean');
    }
    patch.isStatic = body.isStatic;
  }

  if (hasOwn(body, 'trackDefaultBranches')) {
    if (typeof body.trackDefaultBranches !== 'boolean') {
      return new Error('trackDefaultBranches must be a boolean');
    }
    patch.trackDefaultBranches = body.trackDefaultBranches;
  }

  if (hasOwn(body, 'commentRuntimeEnv')) {
    if (!isPlainObject(body.commentRuntimeEnv)) {
      return new Error('commentRuntimeEnv must be an object');
    }
    patch.commentRuntimeEnv = body.commentRuntimeEnv;
  }

  if (hasOwn(body, 'commentInitEnv')) {
    if (!isPlainObject(body.commentInitEnv)) {
      return new Error('commentInitEnv must be an object');
    }
    patch.commentInitEnv = body.commentInitEnv;
  }

  return patch;
}

/**
 * @openapi
 * /api/v2/builds/{uuid}:
 *   get:
 *     summary: Get a build by UUID
 *     description: Returns a build object corresponding to the provided UUID.
 *     tags:
 *       - Builds
 *     operationId: getBuildByUUID
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build to retrieve.
 *     responses:
 *       '200':
 *         description: A build object.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetBuildByUUIDSuccessResponse'
 *       '404':
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '500':
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: { params: { uuid: string } }) => {
  const buildService = new BuildService();

  const build = await buildService.getBuildByUUID(params.uuid);

  if (!build) {
    return errorResponse(new Error(`Build with UUID ${params.uuid} not found`), { status: 404 }, req);
  }

  return successResponse(
    build,
    {
      status: 200,
    },
    req
  );
};

/**
 * @openapi
 * /api/v2/builds/{uuid}:
 *   patch:
 *     summary: Update build config
 *     description: Patches build-table config such as UUID, static mode, default-branch tracking, and comment environment overrides.
 *     tags:
 *       - Builds
 *     operationId: updateBuildConfig
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The current UUID of the build to update.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateBuildConfigPatchRequest'
 *     responses:
 *       '200':
 *         description: Updated build object.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UpdateBuildConfigSuccessResponse'
 *       '400':
 *         description: Invalid request body or unavailable UUID.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Build not found.
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
  const body = (await req.json().catch(() => null)) as UpdateBuildConfigPatchRequest | null;
  const patch = validateBuildConfigPatch(body);

  if (patch instanceof Error) {
    return errorResponse(patch, { status: 400 }, req);
  }

  const override = new OverrideService();
  const buildService = new BuildService();
  const build = await override.db.models.Build.query().findOne({ uuid: params.uuid }).withGraphFetched('pullRequest');

  if (!build) {
    return errorResponse(new Error(`Build with UUID ${params.uuid} not found`), { status: 404 }, req);
  }

  try {
    const updatedBuild = await override.applyBuildConfigPatch({
      build,
      pullRequest: build.pullRequest,
      patch,
      runUuid: nanoid(),
    });

    const hydratedBuild = await buildService.getBuildByUUID(updatedBuild.uuid);

    if (!hydratedBuild) {
      return errorResponse(new Error(`Build with UUID ${updatedBuild.uuid} not found`), { status: 404 }, req);
    }

    return successResponse(hydratedBuild, { status: 200 }, req);
  } catch (error) {
    if (error instanceof BuildUuidValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }

    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const PATCH = createApiHandler(patchHandler);
