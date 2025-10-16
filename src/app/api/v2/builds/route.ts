import { NextRequest } from 'next/server';
import { paginate } from 'server/lib/paginate';
import { errorResponse, successResponse } from 'server/lib/response';
import BuildService from 'server/services/build';

/**
 * @openapi
 * /api/v2/builds:
 *   get:
 *     summary: Get a list of builds
 *     description: Returns a paginated list of builds, optionally excluding certain statuses. Pagination is enabled by default with a default limit of 25 items per page.
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
 *           default: 1
 *         description: Page number for pagination (optional, default is 1).
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 25
 *         description: Number of items per page (optional, default is 25).
 *     responses:
 *       200:
 *         description: A paginated list of builds.
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
 *                         example: "white-poetry-596195"
 *                       status:
 *                         $ref: '#/components/schemas/BuildStatus'
 *                       namespace:
 *                         type: string
 *                         example: "env-white-poetry-596195"
 *                       pullRequest:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           title:
 *                             type: string
 *                             example: "Add new feature"
 *                           fullName:
 *                             type: string
 *                             example: "goodrx/lifecycle"
 *                           githubLogin:
 *                             type: string
 *                             example: "lifecycle-bot"
 *                 metadata:
 *                   type: object
 *                 error:
 *                   type: null
 *                   example: null
 *                   description: Always null on successful responses.
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
 *                   example: null
 *                   description: Always null on error responses.
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
        metadata: { pagination: paginationMetadata },
        status: 200,
      },
      req
    );
  } catch (error) {
    return errorResponse(error, { status: 500 }, req);
  }
}
