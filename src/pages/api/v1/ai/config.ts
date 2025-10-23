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
import GlobalConfigService from 'server/services/globalConfig';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  try {
    const globalConfig = GlobalConfigService.getInstance();
    const aiAgentConfig = await globalConfig.getConfig('aiAgent');

    if (!aiAgentConfig?.enabled) {
      return res.status(200).json({ enabled: false });
    }

    const provider = aiAgentConfig.provider || 'anthropic';
    const apiKeySet = provider === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY : !!process.env.OPENAI_API_KEY;

    return res.status(200).json({
      enabled: true,
      provider,
      configured: apiKeySet,
    });
  } catch (error) {
    return res.status(500).json({ enabled: false });
  }
}
