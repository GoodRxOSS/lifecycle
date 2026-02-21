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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse, errorResponse } from 'server/lib/response';
import { getRequestUserIdentity } from 'server/lib/get-user';
import UserApiKeyService from 'server/services/userApiKey';

const PROVIDER = 'anthropic';

async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return false;
  }
}

/**
 * @openapi
 * /api/v2/ai/agent/api-keys:
 *   get:
 *     summary: Get the authenticated user's Anthropic API key status
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentApiKey
 *     responses:
 *       '200':
 *         description: API key state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   type: object
 *                   required:
 *                     - hasKey
 *                   properties:
 *                     hasKey:
 *                       type: boolean
 *                     provider:
 *                       type: string
 *                     maskedKey:
 *                       type: string
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                 error:
 *                   nullable: true
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Save or replace the authenticated user's Anthropic API key
 *     tags:
 *       - Agent Sessions
 *     operationId: upsertAgentApiKey
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - apiKey
 *             properties:
 *               apiKey:
 *                 type: string
 *     responses:
 *       '201':
 *         description: API key stored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   type: object
 *                   required:
 *                     - hasKey
 *                     - provider
 *                     - maskedKey
 *                     - updatedAt
 *                   properties:
 *                     hasKey:
 *                       type: boolean
 *                     provider:
 *                       type: string
 *                     maskedKey:
 *                       type: string
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                 error:
 *                   nullable: true
 *       '400':
 *         description: Invalid API key payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Delete the authenticated user's Anthropic API key
 *     tags:
 *       - Agent Sessions
 *     operationId: deleteAgentApiKey
 *     responses:
 *       '200':
 *         description: API key deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [request_id, data, error]
 *               properties:
 *                 request_id:
 *                   type: string
 *                 data:
 *                   type: object
 *                   required:
 *                     - deleted
 *                   properties:
 *                     deleted:
 *                       type: boolean
 *                 error:
 *                   nullable: true
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: API key not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const masked = await UserApiKeyService.getMaskedKey(userIdentity.userId, PROVIDER, userIdentity.githubUsername);
  if (!masked) {
    return successResponse({ hasKey: false }, { status: 200 }, req);
  }

  return successResponse(
    { hasKey: true, provider: masked.provider, maskedKey: masked.maskedKey, updatedAt: masked.updatedAt },
    { status: 200 },
    req
  );
};

const postHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const body = await req.json();
  const { apiKey } = body;

  if (!apiKey || typeof apiKey !== 'string') {
    return errorResponse(new Error('apiKey is required and must be a string'), { status: 400 }, req);
  }

  const valid = await validateAnthropicKey(apiKey);
  if (!valid) {
    return errorResponse(new Error('Invalid API key: authentication failed with Anthropic'), { status: 400 }, req);
  }

  await UserApiKeyService.storeKey(userIdentity.userId, PROVIDER, apiKey, userIdentity.githubUsername);
  const masked = await UserApiKeyService.getMaskedKey(userIdentity.userId, PROVIDER, userIdentity.githubUsername);

  return successResponse(
    { hasKey: true, provider: masked!.provider, maskedKey: masked!.maskedKey, updatedAt: masked!.updatedAt },
    { status: 201 },
    req
  );
};

const deleteHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) return errorResponse(new Error('Unauthorized'), { status: 401 }, req);

  const deleted = await UserApiKeyService.deleteKey(userIdentity.userId, PROVIDER, userIdentity.githubUsername);
  if (!deleted) {
    return errorResponse(new Error('No API key found'), { status: 404 }, req);
  }

  return successResponse({ deleted: true }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
export const DELETE = createApiHandler(deleteHandler);
