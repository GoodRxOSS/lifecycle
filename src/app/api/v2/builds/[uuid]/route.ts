import { nanoid } from 'nanoid';
import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { getLogger, LogStage } from 'server/lib/logger';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';
import OverrideService, { BuildUuidValidationError } from 'server/services/override';

interface UpdateBuildUuidRequest {
  uuid?: unknown;
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
 *     summary: Update a build UUID
 *     description: Updates a build UUID and the related deployable and deploy UUID fields.
 *     tags:
 *       - Builds
 *     operationId: updateBuildUUID
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
 *             $ref: '#/components/schemas/UpdateBuildUUIDRequest'
 *     responses:
 *       '200':
 *         description: Updated build object.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UpdateBuildUUIDSuccessResponse'
 *       '400':
 *         description: Invalid or unavailable UUID.
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
  const body = (await req.json().catch(() => null)) as UpdateBuildUuidRequest | null;
  const newUuid = body?.uuid;

  if (!newUuid || typeof newUuid !== 'string') {
    return errorResponse(new Error('uuid is required'), { status: 400 }, req);
  }

  const override = new OverrideService();
  const build = await override.db.models.Build.query().findOne({ uuid: params.uuid }).withGraphFetched('pullRequest');

  if (!build) {
    return errorResponse(new Error(`Build with UUID ${params.uuid} not found`), { status: 404 }, req);
  }

  if (newUuid === build.uuid) {
    return errorResponse(new Error('UUID must be different'), { status: 400 }, req);
  }

  const validation = await override.validateUuid(newUuid, build.id);
  if (!validation.valid) {
    return errorResponse(new Error(validation.error || 'Invalid UUID'), { status: 400 }, req);
  }

  try {
    const result = await override.updateBuildUuid(build, newUuid);

    if (build.pullRequest?.deployOnUpdate) {
      getLogger({ stage: LogStage.BUILD_QUEUED }).info('Triggering redeploy after UUID update');
      await new BuildService().resolveAndDeployBuildQueue.add('resolve-deploy', {
        buildId: build.id,
        runUUID: nanoid(),
        correlationId: req.headers.get('x-request-id') || `api-build-update-${Date.now()}`,
      });
    }

    return successResponse(result.build, { status: 200 }, req);
  } catch (error) {
    if (error instanceof BuildUuidValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }

    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const PATCH = createApiHandler(patchHandler);
