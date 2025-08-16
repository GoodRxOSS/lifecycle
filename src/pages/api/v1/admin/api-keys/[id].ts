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
import AuthService from 'server/services/auth';
import { validateAuth } from 'server/lib/auth/validate';
import rootLogger from 'server/lib/logger';

const logger = rootLogger.child({
  filename: 'api/v1/admin/api-keys/[id].ts',
});

/**
 * @openapi
 * /api/v1/admin/api-keys/{id}:
 *   put:
 *     summary: Update an API key
 *     description: |
 *       Updates metadata for an existing API key. The actual key value cannot be changed.
 *       Requires API key authentication.
 *     tags:
 *       - Admin
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The API key ID
 *         example: 1
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Human-readable name for the API key
 *                 example: "Updated Production API Key"
 *               description:
 *                 type: string
 *                 description: Optional description of the API key's purpose
 *                 example: "Updated description for production service integrations"
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Permission scopes for the API key (future use)
 *                 example: ["read", "write", "admin"]
 *     responses:
 *       200:
 *         description: API key updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "API key updated successfully"
 *                 apiKey:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                       example: 1
 *                     keyId:
 *                       type: string
 *                       example: "Ab1Cd2Ef"
 *                     name:
 *                       type: string
 *                       example: "Updated Production API Key"
 *                     description:
 *                       type: string
 *                       example: "Updated description for production service integrations"
 *                     scopes:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["read", "write", "admin"]
 *                     active:
 *                       type: boolean
 *                       example: true
 *                     githubUserId:
 *                       type: integer
 *                       example: 12345
 *                     githubLogin:
 *                       type: string
 *                       example: "johndoe"
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Bad Request"
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Unauthorized"
 *       404:
 *         description: API key not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Not Found"
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Too Many Requests"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal Server Error"
 *   delete:
 *     summary: Revoke an API key
 *     description: |
 *       Revokes (deactivates) an existing API key. The key will no longer be able to
 *       authenticate requests. This action cannot be undone. Requires API key authentication.
 *     tags:
 *       - Admin
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The API key ID
 *         example: 1
 *     responses:
 *       200:
 *         description: API key revoked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "API key revoked successfully"
 *                 id:
 *                   type: integer
 *                   example: 1
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Bad Request"
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Unauthorized"
 *       404:
 *         description: API key not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Not Found"
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Too Many Requests"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal Server Error"
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { valid } = await validateAuth(req, res);
  if (!valid) return;

  try {
    const authService = new AuthService();
    const { id } = req.query;

    const apiKeyId = parseInt(id as string, 10);
    if (isNaN(apiKeyId)) {
      logger.error('Invalid API key ID provided', { id });
      return res.status(400).json({ error: 'Bad Request' });
    }

    switch (req.method) {
      case 'PUT':
        return await handleUpdateApiKey(req, res, authService, apiKeyId);

      case 'DELETE':
        return await handleRevokeApiKey(req, res, authService, apiKeyId);

      default:
        res.setHeader('Allow', ['PUT', 'DELETE']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
  } catch (error) {
    logger.error('Admin API key endpoint error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleUpdateApiKey(
  req: NextApiRequest,
  res: NextApiResponse,
  authService: AuthService,
  apiKeyId: number
) {
  const { name, description, scopes } = req.body;

  try {
    const updatedKey = await authService.updateApiKey(apiKeyId, {
      name,
      description,
      scopes,
    });

    if (!updatedKey) {
      logger.error('API key not found for update', { apiKeyId });
      return res.status(404).json({ error: 'Not Found' });
    }

    return res.status(200).json({
      message: 'API key updated successfully',
      apiKey: {
        id: updatedKey.id,
        keyId: updatedKey.keyId,
        name: updatedKey.name,
        description: updatedKey.description,
        scopes: updatedKey.scopes,
        active: updatedKey.active,
        githubUserId: updatedKey.githubUserId,
        githubLogin: updatedKey.githubLogin,
        updatedAt: updatedKey.updatedAt,
      },
    });
  } catch (error) {
    logger.error('Failed to update API key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleRevokeApiKey(
  req: NextApiRequest,
  res: NextApiResponse,
  authService: AuthService,
  apiKeyId: number
) {
  try {
    const revoked = await authService.revokeApiKey(apiKeyId);

    if (!revoked) {
      logger.error('API key not found for revocation', { apiKeyId });
      return res.status(404).json({ error: 'Not Found' });
    }

    return res.status(200).json({
      message: 'API key revoked successfully',
      id: apiKeyId,
    });
  } catch (error) {
    logger.error('Failed to revoke API key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
