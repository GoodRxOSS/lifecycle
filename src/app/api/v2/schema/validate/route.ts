import { NextRequest } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import { assertNamedRepositoryAllowed } from 'server/lib/repositoryAuthorization';
import type { Principal } from 'server/lib/principal';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/schema/validate:
 *   get:
 *     summary: Validate lifecycle schema
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: >
 *       Validates the lifecycle schema from a specified GitHub repository and branch.
 *       Requires repos:read and enforces the API key repository constraint.
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
 *         description: Lifecycle schema validation result.
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
 *       '403':
 *         description: Missing repos:read scope or repository access.
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
const getHandler = async (req: NextRequest, principal: Principal) => {
  const { searchParams } = req.nextUrl;
  const buildService = new BuildService();

  const repo = searchParams.get('repo');
  const branch = searchParams.get('branch');

  if (typeof repo !== 'string' || repo.trim() === '' || typeof branch !== 'string' || branch.trim() === '') {
    return errorResponse('Invalid repo or branch in request body', { status: 400 }, req);
  }

  await assertNamedRepositoryAllowed(principal, repo);

  const schemaValidation = await buildService.validateLifecycleSchema(repo, branch);

  return successResponse(
    schemaValidation,
    {
      status: 200,
    },
    req
  );
};

export const GET = createPrincipalApiHandler({ scope: 'repos:read' }, getHandler);
