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
import TelemetryService, { TelemetryEventInput } from 'server/services/telemetry';
import type { TelemetryAttributes, TelemetrySource, TelemetryStatus } from 'server/models/TelemetryEvent';

export const runtime = 'nodejs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVENT_LENGTH = 200;
const MAX_TEXT_FIELD_LENGTH = 200;
const MAX_ATTRIBUTES_SERIALIZED_BYTES = 2048;
const MAX_ATTRIBUTE_STRING_LENGTH = 500;
const SOURCES: TelemetrySource[] = ['cli', 'ui'];
const STATUSES: TelemetryStatus[] = ['success', 'error'];

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isOptionalString(value: unknown, maxLength: number): value is string | null | undefined {
  return value == null || (typeof value === 'string' && value.length <= maxLength);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isOptionalInteger(value: unknown): value is number | null | undefined {
  return value == null || isInteger(value);
}

function isValidAttributeValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.length <= MAX_ATTRIBUTE_STRING_LENGTH;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string' && item.length <= MAX_ATTRIBUTE_STRING_LENGTH);
  }
  return false;
}

function validateAttributes(value: unknown): { attributes?: TelemetryAttributes; error?: string } {
  if (value === undefined) {
    return { attributes: {} };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'attributes must be an object when provided.' };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => isValidAttributeValue(entryValue))) {
    return { error: 'attributes values must be strings, numbers, booleans, or arrays of strings.' };
  }

  if (JSON.stringify(value).length > MAX_ATTRIBUTES_SERIALIZED_BYTES) {
    return { error: `attributes must serialize to at most ${MAX_ATTRIBUTES_SERIALIZED_BYTES} bytes.` };
  }

  return { attributes: value as TelemetryAttributes };
}

function validateEventPayload(body: unknown): { event?: TelemetryEventInput; errors: string[] } {
  const errors: string[] = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object.'] };
  }

  const payload = body as Record<string, unknown>;

  if (typeof payload.source !== 'string' || !SOURCES.includes(payload.source as TelemetrySource)) {
    errors.push(`source must be one of: ${SOURCES.join(', ')}.`);
  }

  if (!isNonEmptyString(payload.clientId, 36) || !UUID_PATTERN.test(payload.clientId)) {
    errors.push('clientId must be a UUID string.');
  }

  if (!isNonEmptyString(payload.event, MAX_EVENT_LENGTH)) {
    errors.push(`event must be a non-empty string of at most ${MAX_EVENT_LENGTH} characters.`);
  }

  const { attributes, error: attributesError } = validateAttributes(payload.attributes);
  if (attributesError) {
    errors.push(attributesError);
  }

  if (payload.durationMs != null && (!isInteger(payload.durationMs) || payload.durationMs < 0)) {
    errors.push('durationMs must be a non-negative integer when provided.');
  }

  if (typeof payload.status !== 'string' || !STATUSES.includes(payload.status as TelemetryStatus)) {
    errors.push(`status must be one of: ${STATUSES.join(', ')}.`);
  }

  if (!isOptionalInteger(payload.exitCode)) {
    errors.push('exitCode must be an integer when provided.');
  }

  if (!isOptionalString(payload.errorClass, MAX_TEXT_FIELD_LENGTH)) {
    errors.push(`errorClass must be a string of at most ${MAX_TEXT_FIELD_LENGTH} characters when provided.`);
  }

  if (!isOptionalInteger(payload.errorHttpStatus)) {
    errors.push('errorHttpStatus must be an integer when provided.');
  }

  if (!isOptionalString(payload.errorCode, MAX_TEXT_FIELD_LENGTH)) {
    errors.push(`errorCode must be a string of at most ${MAX_TEXT_FIELD_LENGTH} characters when provided.`);
  }

  if (!isNonEmptyString(payload.clientVersion, MAX_TEXT_FIELD_LENGTH)) {
    errors.push(`clientVersion must be a non-empty string of at most ${MAX_TEXT_FIELD_LENGTH} characters.`);
  }

  if (!isOptionalString(payload.runtimeVersion, MAX_TEXT_FIELD_LENGTH)) {
    errors.push(`runtimeVersion must be a string of at most ${MAX_TEXT_FIELD_LENGTH} characters when provided.`);
  }

  if (!isOptionalString(payload.platform, MAX_TEXT_FIELD_LENGTH)) {
    errors.push(`platform must be a string of at most ${MAX_TEXT_FIELD_LENGTH} characters when provided.`);
  }

  if (!isOptionalString(payload.arch, MAX_TEXT_FIELD_LENGTH)) {
    errors.push(`arch must be a string of at most ${MAX_TEXT_FIELD_LENGTH} characters when provided.`);
  }

  if (errors.length) {
    return { errors };
  }

  // Whitelist known fields only: the table is deliberately anonymous, so no
  // user identity or unexpected attributes can flow through to storage.
  return {
    errors: [],
    event: {
      source: payload.source as TelemetrySource,
      clientId: (payload.clientId as string).toLowerCase(),
      event: payload.event as string,
      attributes,
      durationMs: (payload.durationMs as number | null | undefined) ?? null,
      status: payload.status as TelemetryStatus,
      exitCode: (payload.exitCode as number | null | undefined) ?? null,
      errorClass: (payload.errorClass as string | null | undefined) ?? null,
      errorHttpStatus: (payload.errorHttpStatus as number | null | undefined) ?? null,
      errorCode: (payload.errorCode as string | null | undefined) ?? null,
      clientVersion: payload.clientVersion as string,
      runtimeVersion: (payload.runtimeVersion as string | null | undefined) ?? null,
      platform: (payload.platform as string | null | undefined) ?? null,
      arch: (payload.arch as string | null | undefined) ?? null,
    },
  };
}

/**
 * @openapi
 * /api/v2/telemetry/events:
 *   post:
 *     summary: Record a telemetry event
 *     description: Stores one anonymous telemetry event from a reporting client (CLI or UI). No user identity is stored.
 *     tags:
 *       - Telemetry
 *     operationId: createTelemetryEvent
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - source
 *               - clientId
 *               - event
 *               - status
 *               - clientVersion
 *             properties:
 *               source:
 *                 type: string
 *                 enum: [cli, ui]
 *                 description: Which client type reported the event.
 *               clientId:
 *                 type: string
 *                 format: uuid
 *                 description: Anonymous per-client identifier.
 *               event:
 *                 type: string
 *                 maxLength: 200
 *                 description: Event name. For the CLI this is the space-joined command path, e.g. "builds list".
 *               attributes:
 *                 type: object
 *                 description: Arbitrary event attributes. Values limited to strings, numbers, booleans, or string arrays; at most 2KB serialized.
 *                 additionalProperties: true
 *               durationMs:
 *                 type: integer
 *                 minimum: 0
 *                 nullable: true
 *               status:
 *                 type: string
 *                 enum: [success, error]
 *               exitCode:
 *                 type: integer
 *                 nullable: true
 *                 description: Process exit code (CLI-only).
 *               errorClass:
 *                 type: string
 *                 nullable: true
 *               errorHttpStatus:
 *                 type: integer
 *                 nullable: true
 *               errorCode:
 *                 type: string
 *                 nullable: true
 *               clientVersion:
 *                 type: string
 *                 description: Version of the reporting client.
 *               runtimeVersion:
 *                 type: string
 *                 nullable: true
 *               platform:
 *                 type: string
 *                 nullable: true
 *               arch:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       '201':
 *         description: Telemetry event recorded.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CreateTelemetryEventSuccessResponse'
 *       '400':
 *         description: Invalid payload.
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
 */
const postHandler = async (req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new Error('Invalid JSON in request body'), { status: 400 }, req);
  }

  const { event, errors } = validateEventPayload(body);
  if (!event) {
    return errorResponse(new Error(`Validation failed: ${errors.join(' ')}`), { status: 400 }, req);
  }

  const service = new TelemetryService();
  const inserted = await service.insertEvent(event);
  return successResponse({ event: { id: inserted.id, createdAt: inserted.createdAt ?? null } }, { status: 201 }, req);
};

export const POST = createApiHandler(postHandler, { auth: 'session' });
