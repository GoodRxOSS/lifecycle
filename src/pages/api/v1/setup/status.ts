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

/**
 * @openapi
 * /api/v1/setup/status:
 *   get:
 *     summary: Get the status of the app setup
 *     description: Get the status of the app setup
 *     tags:
 *       - Setup
 *     responses:
 *       200:
 *         description: The status of the app setup
 */
import { NextApiRequest, NextApiResponse } from 'next';
import GlobalConfigService from 'server/services/globalConfig';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const globalConfigService = new GlobalConfigService();
  const appSetup = await globalConfigService.getConfig('app_setup');
  res.status(200).json({
    installed: appSetup?.installed || false,
    created: appSetup?.created || false,
    restarted: appSetup?.restarted || false,
    url: appSetup?.url || '',
  });
}
