import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';
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
    return errorResponse(`Build with UUID ${params.uuid} not found`, { status: 404 }, req);
  }

  return successResponse(
    build,
    {
      status: 200,
    },
    req
  );
};

export const GET = createApiHandler(getHandler);
