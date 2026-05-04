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
  CustomAgentDefinitionServiceError,
  customAgentDefinitionService,
  serializeUserAgentDefinition,
} from 'server/services/agent/CustomAgentDefinitionService';
import type {
  AgentDefinitionModelPreference,
  UserAgentDefinitionResourceBehavior,
  UserAgentDefinitionUpsertInput,
} from 'server/services/agent/agentDefinitionTypes';
import type { AgentCapabilityCatalogId } from 'server/services/agent/capabilityCatalog';

export const dynamic = 'force-dynamic';

const ALLOWED_REQUEST_FIELDS = new Set([
  'name',
  'description',
  'instructions',
  'capabilityIds',
  'modelPreference',
  'resourceBehavior',
]);
const RESOURCE_BEHAVIORS = new Set<UserAgentDefinitionResourceBehavior>([
  'chat_only',
  'current_workspace_when_available',
]);

function mapDefinitionError(error: unknown, req: NextRequest) {
  if (error instanceof CustomAgentDefinitionServiceError) {
    if (error.code === 'not_found') {
      return errorResponse(error, { status: 404 }, req);
    }

    if (error.code === 'model_unavailable') {
      return errorResponse(error, { status: 409 }, req);
    }

    if (error.code === 'creation_unavailable') {
      return errorResponse(error, { status: 403 }, req);
    }

    return errorResponse(error, { status: 400 }, req);
  }

  throw error;
}

async function readRequestBody(req: NextRequest): Promise<Record<string, unknown> | Error> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Error('Invalid JSON in request body');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Error('Request body must be an object.');
  }

  return body as Record<string, unknown>;
}

function readNullableString(value: unknown, fieldName: string): string | null | Error {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return new Error(`${fieldName} must be a string.`);
  }

  return value;
}

function readRequiredString(value: unknown, fieldName: string): string | Error {
  if (typeof value !== 'string') {
    return new Error(`${fieldName} must be a string.`);
  }

  return value;
}

function readCapabilityIds(value: unknown): AgentCapabilityCatalogId[] | Error {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return new Error('capabilityIds must be an array of strings.');
  }

  return value as AgentCapabilityCatalogId[];
}

function readModelPreference(value: unknown): AgentDefinitionModelPreference | null | Error {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return new Error('modelPreference must be an object or null.');
  }

  const modelPreference = value as Record<string, unknown>;
  const unknownKeys = Object.keys(modelPreference).filter((key) => key !== 'provider' && key !== 'model');
  if (unknownKeys.length > 0) {
    return new Error(`Unsupported modelPreference fields: ${unknownKeys.join(', ')}`);
  }

  const provider = readNullableString(modelPreference.provider, 'modelPreference.provider');
  if (provider instanceof Error) {
    return provider;
  }

  const model = readNullableString(modelPreference.model, 'modelPreference.model');
  if (model instanceof Error) {
    return model;
  }

  return { provider, model };
}

function readResourceBehavior(value: unknown): UserAgentDefinitionResourceBehavior | Error {
  if (typeof value !== 'string' || !RESOURCE_BEHAVIORS.has(value as UserAgentDefinitionResourceBehavior)) {
    return new Error('resourceBehavior must be chat_only or current_workspace_when_available.');
  }

  return value as UserAgentDefinitionResourceBehavior;
}

function parseUpsertBody(body: Record<string, unknown>): UserAgentDefinitionUpsertInput | Error {
  const unsupportedFields = Object.keys(body).filter((key) => !ALLOWED_REQUEST_FIELDS.has(key));
  if (unsupportedFields.length > 0) {
    return new Error(`Unsupported agent definition fields: ${unsupportedFields.join(', ')}`);
  }

  const name = readRequiredString(body.name, 'name');
  if (name instanceof Error) {
    return name;
  }

  const instructions = readRequiredString(body.instructions, 'instructions');
  if (instructions instanceof Error) {
    return instructions;
  }

  const description = readNullableString(body.description, 'description');
  if (description instanceof Error) {
    return description;
  }

  const capabilityRefs = readCapabilityIds(body.capabilityIds);
  if (capabilityRefs instanceof Error) {
    return capabilityRefs;
  }

  const modelPreference = readModelPreference(body.modelPreference);
  if (modelPreference instanceof Error) {
    return modelPreference;
  }

  const resourceBehavior = readResourceBehavior(body.resourceBehavior);
  if (resourceBehavior instanceof Error) {
    return resourceBehavior;
  }

  return {
    name,
    description,
    instructionAddendum: instructions,
    capabilityRefs,
    modelPreference,
    resourceBehavior,
  };
}

/**
 * @openapi
 * /api/v2/ai/agent/definitions:
 *   get:
 *     summary: List current-user custom agent definitions
 *     description: Lists the authenticated user's private custom agent definitions for the unified agent platform.
 *     tags:
 *       - Agent Platform
 *     operationId: listUserAgentDefinitions
 *     responses:
 *       '200':
 *         description: Current user's active custom agent definitions.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ListUserAgentDefinitionsSuccessResponse'
 *       '401':
 *         description: Unauthorized.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Create a current-user custom agent definition
 *     description: Creates a private custom agent definition from user-selectable capabilities and resource behavior.
 *     tags:
 *       - Agent Platform
 *     operationId: createUserAgentDefinition
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserAgentDefinitionUpsertRequest'
 *     responses:
 *       '201':
 *         description: Custom agent definition created.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserAgentDefinitionSuccessResponse'
 *       '400':
 *         description: Invalid request or capability selection.
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
 *         description: Custom-agent creation is unavailable for the caller or selected capabilities.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '409':
 *         description: Selected model is unavailable.
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

  const definitions = await customAgentDefinitionService.listUserDefinitions({ userId: userIdentity.userId });
  return successResponse({ definitions: definitions.map(serializeUserAgentDefinition) }, { status: 200 }, req);
};

const postHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const body = await readRequestBody(req);
  if (body instanceof Error) {
    return errorResponse(body, { status: 400 }, req);
  }

  const input = parseUpsertBody(body);
  if (input instanceof Error) {
    return errorResponse(input, { status: 400 }, req);
  }

  try {
    const definition = await customAgentDefinitionService.createUserDefinition(userIdentity, input);
    return successResponse({ definition: serializeUserAgentDefinition(definition) }, { status: 201 }, req);
  } catch (error) {
    return mapDefinitionError(error, req);
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
