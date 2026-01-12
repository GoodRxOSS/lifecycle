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

import { NextApiRequest, NextApiResponse } from 'next';
import { nanoid } from 'nanoid';
import { withLogContext, getLogger, LogStage } from 'server/lib/logger/index';
import GlobalConfigService from 'server/services/globalConfig';
import TTLCleanupService from 'server/services/ttlCleanup';

/**
 * @openapi
 * /api/v1/admin/ttl/cleanup:
 *   get:
 *     summary: Get TTL cleanup configuration
 *     description: Retrieves the current TTL cleanup configuration from global config
 *     tags:
 *       - Admin
 *       - TTL Cleanup
 *     responses:
 *       200:
 *         description: Successfully retrieved TTL cleanup configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                       description: Whether TTL cleanup is enabled
 *                     dryRun:
 *                       type: boolean
 *                       description: Whether cleanup runs in dry-run mode
 *                     inactivityDays:
 *                       type: number
 *                       description: Number of days of inactivity before cleanup
 *                     checkIntervalMinutes:
 *                       type: number
 *                       description: How often cleanup job runs (in minutes)
 *                     commentTemplate:
 *                       type: string
 *                       description: Template for PR comments
 *                     excludedRepositories:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: List of repositories excluded from cleanup
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: DELETE is not allowed.
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Unable to retrieve TTL cleanup configuration
 *   post:
 *     summary: Manually trigger TTL cleanup
 *     description: Manually triggers a TTL cleanup job with optional configuration override
 *     tags:
 *       - Admin
 *       - TTL Cleanup
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               dryRun:
 *                 type: boolean
 *                 description: Override dry-run mode for this execution (optional)
 *     responses:
 *       200:
 *         description: Successfully triggered TTL cleanup job
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: TTL cleanup job triggered successfully
 *                 jobId:
 *                   type: string
 *                   description: The ID of the queued job
 *                 dryRun:
 *                   type: boolean
 *                   description: Whether this job will run in dry-run mode
 *       400:
 *         description: Bad request - invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: dryRun must be a boolean value
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: DELETE is not allowed.
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Unable to trigger TTL cleanup job
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    switch (req.method) {
      case 'GET':
        return getTTLConfig(res);
      case 'POST':
        return triggerTTLCleanup(req, res);
      default:
        res.setHeader('Allow', ['GET', 'POST']);
        return res.status(405).json({ error: `${req.method} is not allowed.` });
    }
  } catch (error) {
    getLogger().error({ error }, 'Error occurred on TTL cleanup operation');
    res.status(500).json({ error: 'An unexpected error occurred.' });
  }
};

async function getTTLConfig(res: NextApiResponse) {
  try {
    const configService = GlobalConfigService.getInstance();
    const globalConfig = await configService.getAllConfigs();
    const ttlConfig = globalConfig.ttl_cleanup;

    if (!ttlConfig) {
      getLogger().warn('TTL cleanup configuration not found in global config');
      return res.status(404).json({ error: 'TTL cleanup configuration not found' });
    }

    return res.status(200).json({ config: ttlConfig });
  } catch (error) {
    getLogger().error({ error }, 'Error occurred retrieving TTL cleanup config');
    return res.status(500).json({ error: 'Unable to retrieve TTL cleanup configuration' });
  }
}

async function triggerTTLCleanup(req: NextApiRequest, res: NextApiResponse) {
  const correlationId = `api-ttl-cleanup-${Date.now()}-${nanoid(8)}`;

  return withLogContext({ correlationId }, async () => {
    try {
      const { dryRun = false } = req.body || {};

      // Validate dryRun parameter type
      if (typeof dryRun !== 'boolean') {
        return res.status(400).json({ error: 'dryRun must be a boolean value' });
      }

      // Create new service instance and add job to queue
      const ttlCleanupService = new TTLCleanupService();
      const job = await ttlCleanupService.ttlCleanupQueue.add('manual-ttl-cleanup', { dryRun, correlationId });

      getLogger({ stage: LogStage.CLEANUP_STARTING }).info(
        `TTL: cleanup job triggered manually jobId=${job.id} dryRun=${dryRun}`
      );

      return res.status(200).json({
        message: 'TTL cleanup job triggered successfully',
        jobId: job.id,
        dryRun,
      });
    } catch (error) {
      getLogger({ stage: LogStage.CLEANUP_FAILED }).error({ error }, 'Error occurred triggering TTL cleanup');
      return res.status(500).json({ error: 'Unable to trigger TTL cleanup job' });
    }
  });
}
