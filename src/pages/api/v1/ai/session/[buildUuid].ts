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
import { defaultDb, defaultRedis } from 'server/lib/dependencies';
import AIAgentConversationService from 'server/services/ai/conversation/storage';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { buildUuid } = req.query;

  if (!buildUuid || typeof buildUuid !== 'string') {
    return res.status(400).json({ error: 'Invalid buildUuid' });
  }

  const conversationService = new AIAgentConversationService(defaultDb, defaultRedis);
  const clearedCount = await conversationService.clearConversation(buildUuid);

  return res.status(200).json({
    success: true,
    messagesCleared: clearedCount,
  });
}
