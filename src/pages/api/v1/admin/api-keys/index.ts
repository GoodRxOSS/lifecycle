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
  filename: 'api/v1/admin/api-keys/index.ts',
});

/**
 * @openapi
 * /api/v1/admin/api-keys:
 *   post:
 *     summary: Create a new API key
 *     description: |
 *       Creates a new API key for authentication. The full key is only returned once
 *       and cannot be retrieved again.
 *
 *       **Bootstrap Mode**: If no API keys exist in the database, this endpoint
 *       allows creating the first key using a bootstrap token (X-Bootstrap-Token header).
 *       The bootstrap token is provided via the APP_BOOTSTRAP_TOKEN environment variable
 *       during deployment. After the first key is created, all subsequent requests
 *       require API key authentication.
 *     tags:
 *       - Admin
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Bootstrap-Token
 *         required: false
 *         description: |
 *           Bootstrap token required only when creating the first API key.
 *           Must match the APP_BOOTSTRAP_TOKEN environment variable.
 *         schema:
 *           type: string
 *           example: "abc123def456ghi789"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Human-readable name for the API key
 *                 example: "Production API Key"
 *               description:
 *                 type: string
 *                 description: Optional description of the API key's purpose
 *                 example: "Used for production service integrations"
 *               githubUserId:
 *                 type: integer
 *                 description: GitHub user ID associated with this key
 *                 example: 12345
 *               githubLogin:
 *                 type: string
 *                 description: GitHub username associated with this key
 *                 example: "johndoe"
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Permission scopes for the API key (future use)
 *                 example: ["read", "write"]
 *     responses:
 *       201:
 *         description: API key created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "API key created successfully"
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
 *                       example: "Production API Key"
 *                     description:
 *                       type: string
 *                       example: "Used for production service integrations"
 *                     scopes:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["read", "write"]
 *                     githubUserId:
 *                       type: integer
 *                       example: 12345
 *                     githubLogin:
 *                       type: string
 *                       example: "johndoe"
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                 fullKey:
 *                   type: string
 *                   description: The complete API key (shown only once)
 *                   example: "lfc_Ab1Cd2Ef_9xKzPqR8sT2vN7wE3mF6aL4bC8nQ1uY5"
 *                 warning:
 *                   type: string
 *                   example: "Please save this key securely. It cannot be retrieved again."
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
 *   get:
 *     summary: List all API keys
 *     description: |
 *       Retrieves a list of all API keys with sensitive information masked.
 *       Only shows metadata, not the actual key values. Requires API key authentication.
 *     tags:
 *       - Admin
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Successfully retrieved API keys list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKeys:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                         example: 1
 *                       keyId:
 *                         type: string
 *                         description: Public portion of the API key
 *                         example: "Ab1Cd2Ef"
 *                       name:
 *                         type: string
 *                         example: "Production API Key"
 *                       description:
 *                         type: string
 *                         example: "Used for production service integrations"
 *                       active:
 *                         type: boolean
 *                         example: true
 *                       githubUserId:
 *                         type: integer
 *                         example: 12345
 *                       githubLogin:
 *                         type: string
 *                         example: "johndoe"
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *                       lastUsedAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                 total:
 *                   type: integer
 *                   description: Total number of API keys
 *                   example: 5
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
  try {
    const authService = new AuthService();

    // Bootstrap mode: Allow first API key creation with bootstrap token
    if (req.method === 'POST') {
      const hasKeys = await authService.hasApiKeys();

      if (!hasKeys) {
        const providedToken = req.headers['x-bootstrap-token'] as string;
        const bootstrapToken = process.env.APP_BOOTSTRAP_TOKEN;

        if (bootstrapToken && providedToken === bootstrapToken) {
          logger.info('Bootstrap mode: Creating first API key with bootstrap token');
          return await handleCreateApiKey(req, res, authService);
        } else {
          logger.warn('Bootstrap mode: Invalid or missing bootstrap token');
          return res.status(401).json({ error: 'Unauthorized' });
        }
      }
    }

    // Validate auth if api keys exist already
    const { valid } = await validateAuth(req, res);
    if (!valid) return;

    switch (req.method) {
      case 'POST':
        return await handleCreateApiKey(req, res, authService);

      case 'GET':
        return await handleListApiKeys(req, res, authService);

      default:
        res.setHeader('Allow', ['GET', 'POST']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
  } catch (error) {
    logger.error('Admin API key endpoint error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleCreateApiKey(req: NextApiRequest, res: NextApiResponse, authService: AuthService) {
  const { name, description, githubUserId, githubLogin, scopes } = req.body;

  if (!name) {
    logger.error('API key creation attempted without name');
    return res.status(400).json({ error: 'Bad Request' });
  }

  try {
    const result = await authService.createApiKey({
      name,
      description,
      githubUserId,
      githubLogin,
      scopes,
    });

    // Return the full key only on creation
    return res.status(201).json({
      message: 'API key created successfully',
      apiKey: {
        id: result.apiKey.id,
        keyId: result.apiKey.keyId,
        name: result.apiKey.name,
        description: result.apiKey.description,
        scopes: result.apiKey.scopes,
        githubUserId: result.apiKey.githubUserId,
        githubLogin: result.apiKey.githubLogin,
        createdAt: result.apiKey.createdAt,
      },
      fullKey: result.fullKey,
      warning: 'Please save this key securely. It cannot be retrieved again.',
    });
  } catch (error) {
    logger.error('Failed to create API key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleListApiKeys(req: NextApiRequest, res: NextApiResponse, authService: AuthService) {
  try {
    const apiKeys = await authService.listApiKeys();

    return res.status(200).json({
      apiKeys: apiKeys.map((key) => ({
        id: key.id,
        keyId: key.keyId,
        name: key.name,
        description: key.description,
        active: key.active,
        githubUserId: key.githubUserId,
        githubLogin: key.githubLogin,
        createdAt: key.createdAt,
        updatedAt: key.updatedAt,
        lastUsedAt: key.lastUsedAt,
      })),
      total: apiKeys.length,
    });
  } catch (error) {
    logger.error('Failed to list API keys:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
