/**
 * Copyright 2026 GoodRx, Inc.
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
import AIAgentConfigService from 'server/services/aiAgentConfig';
import UserApiKeyService from 'server/services/userApiKey';
import {
  STORED_AGENT_PROVIDER_NAMES,
  normalizeStoredAgentProviderName,
  type StoredAgentProviderName,
} from 'server/services/agent/providerConfig';

type SupportedProvider = StoredAgentProviderName;

type ProviderKeyState = {
  provider: SupportedProvider;
  hasKey: boolean;
  maskedKey?: string;
  updatedAt?: string | null;
};

function normalizeProvider(value: unknown): SupportedProvider | null {
  return normalizeStoredAgentProviderName(value);
}

function getSearchParam(req: NextRequest, key: string): string | null {
  return req.nextUrl?.searchParams?.get(key) || null;
}

async function getConfiguredProviders(): Promise<SupportedProvider[]> {
  try {
    const config = await AIAgentConfigService.getInstance().getEffectiveConfig();
    const configuredProviders = (config.providers || [])
      .map((provider: { name?: unknown; enabled?: unknown }) =>
        provider.enabled !== false && typeof provider.name === 'string' ? normalizeProvider(provider.name) : null
      )
      .filter((provider): provider is SupportedProvider => provider != null);

    return configuredProviders.length > 0 ? [...new Set(configuredProviders)] : [...STORED_AGENT_PROVIDER_NAMES];
  } catch {
    return [...STORED_AGENT_PROVIDER_NAMES];
  }
}

async function validateProviderKey(provider: SupportedProvider, apiKey: string): Promise<boolean> {
  try {
    switch (provider) {
      case 'anthropic': {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
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
        return response.status !== 401 && response.status !== 403;
      }
      case 'openai': {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
        return response.status !== 401 && response.status !== 403;
      }
      case 'gemini': {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        return response.status !== 401 && response.status !== 403;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

async function buildProviderState(
  userId: string,
  ownerGithubUsername: string | null | undefined,
  provider: SupportedProvider
): Promise<ProviderKeyState> {
  const masked = await UserApiKeyService.getMaskedKey(userId, provider, ownerGithubUsername);
  if (!masked) {
    return {
      provider,
      hasKey: false,
    };
  }

  return {
    provider,
    hasKey: true,
    maskedKey: masked.maskedKey,
    updatedAt: masked.updatedAt,
  };
}

/**
 * @openapi
 * /api/v2/ai/agent/api-keys:
 *   get:
 *     summary: Get stored API key status for enabled agent providers
 *     tags:
 *       - Agent Sessions
 *     operationId: getAgentApiKeys
 *     parameters:
 *       - in: query
 *         name: provider
 *         schema:
 *           type: string
 *           enum: [anthropic, openai, gemini]
 *         description: Optionally narrow the response to one provider.
 *     responses:
 *       '200':
 *         description: Provider API key states
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentApiKeyStatusResponse'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Save or replace a stored API key for an agent provider
 *     tags:
 *       - Agent Sessions
 *     operationId: upsertAgentApiKey
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider, apiKey]
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: [anthropic, openai, gemini]
 *               apiKey:
 *                 type: string
 *     responses:
 *       '201':
 *         description: API key stored
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/AgentApiKeyStatus'
 *       '400':
 *         description: Invalid provider or API key
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
 *     summary: Delete a stored API key for an agent provider
 *     tags:
 *       - Agent Sessions
 *     operationId: deleteAgentApiKey
 *     parameters:
 *       - in: query
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *           enum: [anthropic, openai, gemini]
 *     responses:
 *       '200':
 *         description: API key deleted
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       type: object
 *                       required: [deleted, provider]
 *                       properties:
 *                         deleted:
 *                           type: boolean
 *                         provider:
 *                           type: string
 *                           enum: [anthropic, openai, gemini]
 *       '400':
 *         description: Provider is required
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
 *       '404':
 *         description: API key not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const providerParam = getSearchParam(req, 'provider');
  const requestedProvider = providerParam == null ? null : normalizeProvider(providerParam);
  if (providerParam != null && !requestedProvider) {
    return errorResponse(new Error('provider must be one of anthropic, openai, gemini'), { status: 400 }, req);
  }
  const configuredProviders = await getConfiguredProviders();
  const providers = requestedProvider ? [requestedProvider] : configuredProviders;
  const states = await Promise.all(
    providers.map((provider) => buildProviderState(userIdentity.userId, userIdentity.githubUsername, provider))
  );
  const primaryState = states[0] || {
    provider: configuredProviders[0],
    hasKey: false,
  };

  return successResponse(
    {
      hasKey: primaryState.hasKey,
      provider: primaryState.provider,
      maskedKey: primaryState.maskedKey,
      updatedAt: primaryState.updatedAt,
      providers: states,
    },
    { status: 200 },
    req
  );
};

const postHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const body = await req.json().catch(() => ({}));
  const provider = normalizeProvider(body?.provider);
  if (!provider) {
    return errorResponse(new Error('provider must be one of anthropic, openai, gemini'), { status: 400 }, req);
  }
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';

  if (!apiKey) {
    return errorResponse(new Error('apiKey is required and must be a string'), { status: 400 }, req);
  }

  const valid = await validateProviderKey(provider, apiKey);
  if (!valid) {
    return errorResponse(new Error(`Invalid API key: authentication failed with ${provider}`), { status: 400 }, req);
  }

  await UserApiKeyService.storeKey(userIdentity.userId, provider, apiKey, userIdentity.githubUsername);
  const state = await buildProviderState(userIdentity.userId, userIdentity.githubUsername, provider);

  return successResponse(state, { status: 201 }, req);
};

const deleteHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const provider = normalizeProvider(getSearchParam(req, 'provider'));
  if (!provider) {
    return errorResponse(new Error('provider must be one of anthropic, openai, gemini'), { status: 400 }, req);
  }

  const deleted = await UserApiKeyService.deleteKey(userIdentity.userId, provider, userIdentity.githubUsername);
  if (!deleted) {
    return errorResponse(new Error('No API key found'), { status: 404 }, req);
  }

  return successResponse({ deleted: true, provider }, { status: 200 }, req);
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
export const DELETE = createApiHandler(deleteHandler);
