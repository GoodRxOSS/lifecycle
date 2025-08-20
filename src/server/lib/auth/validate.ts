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
import AuthService from '../../services/auth';
import { checkRateLimit } from './rateLimiter';
import ApiKey from '../../models/ApiKey';
import rootLogger from '../logger';

const logger = rootLogger.child({
  filename: 'lib/auth/validateAuth.ts',
});

/**
 * Validate API key and rate limits
 * This is called from within API route handlers after the edge middleware
 * has done basic format validation
 */
export async function validateAuth(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<{ valid: boolean; apiKey?: ApiKey }> {
  try {
    const authHeader = req.headers.authorization as string;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.error('Missing or invalid Authorization header');
      res.status(401).json({ error: 'Unauthorized' });
      return { valid: false };
    }

    const apiKeyString = authHeader.substring(7); // Remove 'Bearer ' prefix

    const authService = new AuthService();

    const config = await authService.getApiConfig();

    const apiKey = await authService.validateApiKey(apiKeyString);

    if (!apiKey) {
      logger.error('Invalid API key provided');
      res.status(401).json({ error: 'Unauthorized' });
      return { valid: false };
    }

    // Check rate limits
    const rateLimitResult = await checkRateLimit(apiKey.keyId, config.rate_limit, config.rate_limit_window);

    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit.toString());
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining.toString());
    res.setHeader('X-RateLimit-Reset', new Date(rateLimitResult.resetAt).toISOString());

    if (!rateLimitResult.allowed) {
      logger.error('Rate limit exceeded for API key', { keyId: apiKey.keyId });
      res.status(429).json({ error: 'Too Many Requests' });
      return { valid: false };
    }

    // Update last used timestamp (async, non-blocking)
    await authService.updateLastUsed(apiKey);

    return { valid: true, apiKey };
  } catch (error) {
    logger.error('API key validation error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
    return { valid: false };
  }
}
