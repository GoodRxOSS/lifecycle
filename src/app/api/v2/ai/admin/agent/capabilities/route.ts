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
import { errorResponse, successResponse } from 'server/lib/response';
import { normalizeRepoFullName } from 'server/lib/normalizeRepoFullName';
import { AgentRuntimeConfigValidationError } from 'server/lib/validation/agentRuntimeConfigValidator';
import AgentRuntimeConfigService from 'server/services/agentRuntime/config/agentRuntimeConfig';
import AgentSessionConfigService from 'server/services/agentSessionConfig';
import type { CapabilityPolicyConfig } from 'server/services/types/agentRuntimeConfig';

export const dynamic = 'force-dynamic';

type ParsedScope =
  | {
      scopeType: 'global';
      scope: 'global';
      repoFullName?: undefined;
    }
  | {
      scopeType: 'repo';
      scope: string;
      repoFullName: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseScope(req: NextRequest): ParsedScope | Error {
  const rawScope = req.nextUrl.searchParams.get('scope')?.trim() || 'global';
  if (rawScope === 'global') {
    return { scopeType: 'global', scope: 'global' };
  }

  const repoFullName = normalizeRepoFullName(rawScope);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
    return new Error(
      'Repo capability scope must be "global" or a repository full name like "example-org/example-repo".'
    );
  }

  return {
    scopeType: 'repo',
    scope: repoFullName,
    repoFullName,
  };
}

function readCapabilityPolicy(body: unknown): CapabilityPolicyConfig | Error {
  if (!isRecord(body)) {
    return new Error('Request body must be an object.');
  }

  const capabilityPolicy = body.capabilityPolicy;
  if (!isRecord(capabilityPolicy)) {
    return new Error('Request body must include capabilityPolicy.');
  }

  if (capabilityPolicy.availability !== undefined && !isRecord(capabilityPolicy.availability)) {
    return new Error('capabilityPolicy.availability must be an object.');
  }

  return capabilityPolicy as CapabilityPolicyConfig;
}

async function buildResponse(scope: ParsedScope) {
  const agentRuntimeConfigService = AgentRuntimeConfigService.getInstance();
  const [globalConfig, repoConfig, effectiveConfig, capabilities] = await Promise.all([
    agentRuntimeConfigService.getGlobalConfig(),
    scope.repoFullName ? agentRuntimeConfigService.getRepoConfig(scope.repoFullName) : Promise.resolve(null),
    agentRuntimeConfigService.getEffectiveConfig(scope.repoFullName),
    AgentSessionConfigService.getInstance().listCapabilityInventory(scope.scope),
  ]);
  const capabilityPolicy =
    scope.scopeType === 'global' ? globalConfig.capabilityPolicy || {} : repoConfig?.capabilityPolicy || {};

  return {
    scope: scope.scope,
    scopeType: scope.scopeType,
    ...(scope.repoFullName ? { repoFullName: scope.repoFullName } : {}),
    capabilityPolicy,
    ...(scope.scopeType === 'repo' ? { inheritedCapabilityPolicy: globalConfig.capabilityPolicy || {} } : {}),
    effectiveCapabilityPolicy: effectiveConfig.capabilityPolicy || {},
    capabilities,
  };
}

/**
 * @openapi
 * /api/v2/ai/admin/agent/capabilities:
 *   get:
 *     summary: Get agent capability policy inventory
 *     description: Returns catalog-backed capability rows and effective capability policy for an admin scope.
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminAgentCapabilities
 *     parameters:
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *         description: Use `global` or a repository full name such as `example-org/example-repo`.
 *     responses:
 *       '200':
 *         description: Capability governance inventory.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentCapabilitiesSuccessResponse'
 *       '400':
 *         description: Invalid scope.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Update agent capability policy
 *     description: Updates the capability policy for the selected global or repository scope.
 *     tags:
 *       - Agent Admin
 *     operationId: updateAdminAgentCapabilities
 *     parameters:
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           default: global
 *         description: Use `global` or a repository full name such as `example-org/example-repo`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateAdminAgentCapabilitiesRequest'
 *     responses:
 *       '200':
 *         description: Updated capability governance inventory.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetAdminAgentCapabilitiesSuccessResponse'
 *       '400':
 *         description: Validation error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const scope = parseScope(req);
  if (scope instanceof Error) {
    return errorResponse(scope, { status: 400 }, req);
  }

  return successResponse(await buildResponse(scope), { status: 200 }, req);
};

const putHandler = async (req: NextRequest) => {
  const scope = parseScope(req);
  if (scope instanceof Error) {
    return errorResponse(scope, { status: 400 }, req);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const capabilityPolicy = readCapabilityPolicy(body);
  if (capabilityPolicy instanceof Error) {
    return errorResponse(capabilityPolicy, { status: 400 }, req);
  }

  const agentRuntimeConfigService = AgentRuntimeConfigService.getInstance();
  try {
    if (scope.scopeType === 'global') {
      await agentRuntimeConfigService.updateGlobalCapabilityPolicy(capabilityPolicy);
    } else {
      await agentRuntimeConfigService.updateRepoCapabilityPolicy(scope.repoFullName, capabilityPolicy);
    }
  } catch (error) {
    if (error instanceof AgentRuntimeConfigValidationError) {
      return errorResponse(error, { status: 400 }, req);
    }
    throw error;
  }

  return successResponse(await buildResponse(scope), { status: 200 }, req);
};

export const GET = createApiHandler(getHandler, { roles: ['admin'] });
export const PUT = createApiHandler(putHandler, { roles: ['admin'] });
