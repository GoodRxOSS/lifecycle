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
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';
import {
  customAgentDefinitionService,
  type UserAgentDefinitionCapability,
} from 'server/services/agent/CustomAgentDefinitionService';
import type { UserAgentDefinitionResourceBehavior } from 'server/services/agent/agentDefinitionTypes';

export const dynamic = 'force-dynamic';

const DEFAULT_RESOURCE_BEHAVIOR: UserAgentDefinitionResourceBehavior = 'current_workspace_when_available';
const RESOURCE_BEHAVIORS = new Set<UserAgentDefinitionResourceBehavior>([
  'chat_only',
  'current_workspace_when_available',
]);

function parseResourceBehavior(req: NextRequest): UserAgentDefinitionResourceBehavior | Error {
  const value = req.nextUrl.searchParams.get('resourceBehavior')?.trim() || DEFAULT_RESOURCE_BEHAVIOR;
  if (!RESOURCE_BEHAVIORS.has(value as UserAgentDefinitionResourceBehavior)) {
    return new Error('resourceBehavior must be chat_only or current_workspace_when_available.');
  }

  return value as UserAgentDefinitionResourceBehavior;
}

function serializeCapability(capability: UserAgentDefinitionCapability): UserAgentDefinitionCapability {
  return {
    capabilityId: capability.capabilityId,
    label: capability.label,
    description: capability.description,
    category: capability.category,
    toolCount: capability.toolCount,
    resourceCount: capability.resourceCount,
    requiresWorkspace: capability.requiresWorkspace,
    tools: capability.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    resources: capability.resources.map((resource) => ({
      name: resource.name,
      description: resource.description,
    })),
  };
}

/**
 * @openapi
 * /api/v2/ai/agent/definition-capabilities:
 *   get:
 *     summary: List capabilities available for custom agent definitions
 *     description: Returns creator eligibility and only capabilities the current user can select for private custom agents.
 *     tags:
 *       - Agent Platform
 *     operationId: listUserAgentDefinitionCapabilities
 *     parameters:
 *       - in: query
 *         name: resourceBehavior
 *         schema:
 *           $ref: '#/components/schemas/UserAgentDefinitionResourceBehavior'
 *         description: Resource behavior to use when filtering source-compatible capabilities.
 *     responses:
 *       '200':
 *         description: User-visible capability inventory.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserAgentDefinitionCapabilitiesSuccessResponse'
 *       '400':
 *         description: Invalid resource behavior.
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
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const resourceBehavior = parseResourceBehavior(req);
  if (resourceBehavior instanceof Error) {
    return errorResponse(resourceBehavior, { status: 400 }, req);
  }

  const creationStatus = await customAgentDefinitionService.getUserDefinitionCreationStatus({ userIdentity });
  if (!creationStatus.canCreate) {
    return successResponse({ resourceBehavior, ...creationStatus, capabilities: [] }, { status: 200 }, req);
  }

  const capabilities = await customAgentDefinitionService.listUserSelectableCapabilities({
    userIdentity,
    resourceBehavior,
  });

  return successResponse(
    { resourceBehavior, ...creationStatus, capabilities: capabilities.map(serializeCapability) },
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler);
