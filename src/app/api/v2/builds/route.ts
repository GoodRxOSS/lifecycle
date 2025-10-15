import { NextRequest } from 'next/server';
import { paginate } from 'server/lib/paginate';
import { errorResponse, successResponse } from 'server/lib/standardizedResponse';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/builds:
 *   get:
 *     summary: Get a list of builds
 *     description: Returns a list of builds, optionally excluding certain statuses.
 *     tags:
 *       - Builds
 *     parameters:
 *       - in: query
 *         name: exclude
 *         schema:
 *           type: string
 *           default: ""
 *           example: "pending,failed"
 *         description: >
 *           Comma-separated list of build statuses to exclude from the results.
 *           Each value must be a valid BuildStatus (see Schemas -> BuildStatus).
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number for pagination (optional).
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of items per page (optional).
 *     responses:
 *       200:
 *         description: A list of builds.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       uuid:
 *                         type: string
 *                       status:
 *                         $ref: '#/components/schemas/BuildStatus'
 *                       namespace:
 *                         type: string
 *                       pullRequest:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           title:
 *                             type: string
 *                           fullName:
 *                             type: string
 *                           githubLogin:
 *                             type: string
 *                 metadata:
 *                   type: object
 *                 error:
 *                   type: object
 *                   nullable: true
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   type: null
 *                 error:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  try {
    const buildService = new BuildService();

    const excludeQuery = searchParams.get('exclude');
    const excludeStatuses = excludeQuery ? excludeQuery.split(',').map((s) => s.trim()) : [];

    const baseQuery = buildService.db.models.Build.query()
      .select('id', 'uuid', 'status', 'namespace')
      .whereNotIn('status', excludeStatuses)
      .withGraphFetched('pullRequest')
      .modifyGraph('pullRequest', (builder) => {
        builder.select('id', 'title', 'fullName', 'githubLogin');
      })
      .orderBy('updatedAt', 'desc');

    const { data, metadata: paginationMetadata } = await paginate(baseQuery, searchParams);

    return successResponse(
      data,
      {
        ...(paginationMetadata && { metadata: { pagination: paginationMetadata } }),
        status: 200,
      },
      req
    );
  } catch (error) {
    return errorResponse(error, 500, req);
  }
}
