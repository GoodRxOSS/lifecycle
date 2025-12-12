import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/schema/validate:
 *   get:
 *     summary: Validate lifecycle schema
 *     description: Validates the lifecycle schema from a specified GitHub repository and branch.
 *     tags:
 *       - Schema
 *     operationId: validateLifecycleSchema
 *     parameters:
 *       - in: query
 *         name: repo
 *         schema:
 *           type: string
 *         required: true
 *         description: The GitHub repository in the format "owner/repo".
 *       - in: query
 *         name: branch
 *         schema:
 *           type: string
 *         required: true
 *         description: The branch name in the repository.
 *     responses:
 *       '200':
 *         description: A paginated list of builds.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidateLifecycleSchemaSuccessResponse'
 *       '400':
 *         description: Bad request
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
const getHandler = async (req: NextRequest) => {
  const { searchParams } = req.nextUrl;
  const buildService = new BuildService();

  const repo = searchParams.get('repo');
  const branch = searchParams.get('branch');

  if (![repo, branch].every((val) => typeof val === 'string' && val.trim() !== '')) {
    return errorResponse('Invalid repo or branch in request body', { status: 400 }, req);
  }

  const schemaValidation = await buildService.validateLifecycleSchema(repo, branch);

  return successResponse(
    schemaValidation,
    {
      status: 200,
    },
    req
  );
};

export const GET = createApiHandler(getHandler);
