/**
 * Copyright 2025 GoodRx, Inc.
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

import { NextApiRequest, NextApiResponse } from 'next/types';
import { nanoid } from 'nanoid';
import { withLogContext, getLogger, LogStage } from 'server/lib/logger/index';
import GithubService from 'server/services/github';
import { Build } from 'server/models';
import WebhookService from 'server/services/webhook';

/**
 * @openapi
 * /api/v1/builds/{uuid}/webhooks:
 *   get:
 *     summary: Retrieve webhook invocations for a build
 *     description: |
 *       Retrieves a paginated list of webhook invocations for a specific build,
 *       ordered by creation date in descending order.
 *     tags:
 *       - Webhooks
 *       - Builds
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 100
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Successfully retrieved webhook invocations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 webhooks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: Webhook invocation details
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     currentPage:
 *                       type: integer
 *                       example: 1
 *                     totalPages:
 *                       type: integer
 *                       example: 5
 *                     total:
 *                       type: integer
 *                       example: 42
 *                     limit:
 *                       type: integer
 *                       example: 100
 *       404:
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Build not found for abc-123
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Unable to retrieve webhooks for build abc-123.
 *   post:
 *     summary: Invoke webhooks for a build
 *     description: |
 *       Triggers the execution of configured webhooks for a specific build.
 *       The webhooks must be defined in the build's webhooksYaml configuration.
 *     tags:
 *       - Webhooks
 *       - Builds
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *     responses:
 *       200:
 *         description: Webhooks successfully queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Webhook for build abc-123 has been queued
 *       204:
 *         description: No webhooks configured for the build
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: no_content
 *                 message:
 *                   type: string
 *                   example: No webhooks found for build abc-123.
 *       400:
 *         description: Invalid UUID provided
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid UUID
 *       404:
 *         description: Build not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Build not found for abc-123
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: PUT is not allowed.
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Unable to proceed with triggering webhook for build abc-123.
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  const { uuid } = req.query;

  if (!uuid || typeof uuid !== 'string') {
    return res.status(400).json({ error: 'Invalid UUID' });
  }

  return withLogContext({ buildUuid: uuid }, async () => {
    try {
      switch (req.method) {
        case 'GET':
          return retrieveWebhooks(req, res);
        case 'POST':
          return invokeWebhooks(req, res);
        default:
          res.setHeader('Allow', ['GET', 'POST']);
          return res.status(405).json({ error: `${req.method} is not allowed.` });
      }
    } catch (error) {
      getLogger({ error }).error(`Error handling ${req.method} request`);
      res.status(500).json({ error: 'An unexpected error occurred.' });
    }
  });
};

async function invokeWebhooks(req: NextApiRequest, res: NextApiResponse) {
  const { uuid } = req.query;
  const correlationId = `api-webhook-invoke-${Date.now()}-${nanoid(8)}`;

  return withLogContext({ correlationId }, async () => {
    try {
      const githubService = new GithubService();
      const build: Build = await githubService.db.models.Build.query().findOne({
        uuid,
      });

      const buildId = build.id;

      if (!build) {
        getLogger().debug('Build not found');
        return res.status(404).json({ error: `Build not found for ${uuid}` });
      }

      if (!build.webhooksYaml) {
        getLogger().debug('No webhooks found for build');
        return res.status(204).json({
          status: 'no_content',
          message: `No webhooks found for build ${uuid}.`,
        });
      }

      const webhookService = new WebhookService();
      await webhookService.webhookQueue.add('webhook', {
        buildId,
        correlationId,
      });

      getLogger({ stage: LogStage.WEBHOOK_PROCESSING }).info('Webhook invocation queued via API');

      return res.status(200).json({
        status: 'success',
        message: `Webhook for build ${uuid} has been queued`,
      });
    } catch (error) {
      getLogger({ stage: LogStage.WEBHOOK_PROCESSING, error }).error(
        `Unable to proceed with webhook for build ${uuid}`
      );
      return res.status(500).json({ error: `Unable to proceed with triggering webhook for build ${uuid}.` });
    }
  });
}

async function retrieveWebhooks(req: NextApiRequest, res: NextApiResponse) {
  const { uuid, page = 1, limit = 100 } = req.query;
  try {
    const pageNumber = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNumber = Math.max(1, parseInt(limit as string, 10) || 10);
    const offset = (pageNumber - 1) * limitNumber;

    const webhookService = new WebhookService();

    const buildId = webhookService.db.models.Build.query().select('id').where('uuid', uuid).first();

    if (!buildId) {
      return res.status(404).json({ error: `Build not found for ${uuid}` });
    }

    const total = await webhookService.db.models.WebhookInvocations.query().where('buildId', buildId).resultSize();

    const webhooks = await webhookService.db.models.WebhookInvocations.query()
      .where('buildId', buildId)
      .orderBy('createdAt', 'desc')
      .offset(offset)
      .limit(limitNumber);
    const totalPages = Math.ceil(total / limitNumber);
    res.status(200).json({
      webhooks,
      metadata: {
        currentPage: pageNumber,
        totalPages,
        total,
        limit: limitNumber,
      },
    });
  } catch (error) {
    getLogger({ error }).error('Failed to retrieve webhooks');
    return res.status(500).json({ error: `Unable to retrieve webhooks for build ${uuid}.` });
  }
}
