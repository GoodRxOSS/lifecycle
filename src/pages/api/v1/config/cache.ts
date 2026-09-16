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
import { getLogger } from 'server/lib/logger';
import { verifyBearerToken } from 'server/lib/auth';
import { getIdentityFromClaims } from 'server/lib/get-user';
import GlobalConfigService from 'server/services/globalConfig';

/**
 * @openapi
 * /api/v1/config/cache:
 *   get:
 *     summary: Retrieve global configuration
 *     description: Fetches the current global configuration values from cache
 *     tags:
 *       - Configuration
 *     responses:
 *       200:
 *         description: Successfully retrieved configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configs:
 *                   type: object
 *                   description: Global configuration values
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: POST is not allowed.
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Unable to retrieve global config values
 *   put:
 *     summary: Refresh and retrieve global configuration
 *     description: Forces a refresh of the cached configuration values and returns the updated configuration
 *     tags:
 *       - Configuration
 *     responses:
 *       200:
 *         description: Successfully refreshed and retrieved configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configs:
 *                   type: object
 *                   description: Updated global configuration values
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: POST is not allowed.
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Unable to retrieve global config values
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  // V1 bypasses auth middleware: verify bearer cryptographically here; x-user is attacker-controlled.
  if (process.env.ENABLE_AUTH !== 'true') return res.status(403).json({ error: 'Administrator session required.' });
  const authorization = req.headers.authorization;
  const bearer =
    typeof authorization === 'string' && authorization.length <= 16384 ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
  if (!bearer) return res.status(403).json({ error: 'Administrator session required.' });
  const verified = await verifyBearerToken(bearer[1]);
  const identity = verified.success ? getIdentityFromClaims(verified.payload ?? null) : null;
  if (!identity?.issuer || !identity.roles.includes('admin')) {
    return res.status(403).json({ error: 'Administrator session required.' });
  }
  try {
    switch (req.method) {
      case 'GET':
        return getCachedConfig(res);
      case 'PUT':
        return getCachedConfig(res, true);
      default:
        res.setHeader('Allow', ['GET', 'PUT']);
        return res.status(405).json({ error: `${req.method} is not allowed.` });
    }
  } catch (error) {
    getLogger().error({ error }, 'Config: cache operation failed');
    res.status(500).json({ error: 'An unexpected error occurred.' });
  }
};

async function getCachedConfig(res: NextApiResponse, refresh: boolean = false) {
  try {
    const configService = new GlobalConfigService();
    const configs = await configService.getAllConfigs(refresh);
    return res.status(200).json({ configs });
  } catch (error) {
    getLogger().error({ error }, 'Config: cache retrieval failed');
    return res.status(500).json({ error: `Unable to retrieve global config values` });
  }
}
