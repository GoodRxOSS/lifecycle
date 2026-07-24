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

import { BadRequestError } from 'server/lib/appError';

export type JsonObject = Record<string, unknown>;

export const ENVIRONMENT_CREATE_FIELDS = [
  'repository',
  'branch',
  'sha',
  'environmentId',
  'name',
  'services',
  'env',
  'initEnv',
  'deployEnabled',
  'trackDefaultBranches',
  'autoTrack',
  'ttlHours',
  'idempotencyKey',
] as const;

export const ENVIRONMENT_PATCH_FIELDS = [
  'services',
  'env',
  'initEnv',
  'deployEnabled',
  'autoTrack',
  'trackDefaultBranches',
] as const;

const SERVICE_OVERRIDE_FIELDS = ['name', 'active', 'branchOrExternalUrl'] as const;

export interface EnvironmentServiceOverrideInput {
  name: string;
  active?: boolean;
  branchOrExternalUrl?: string;
}

const hasOwn = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function assertJsonObject(value: unknown): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('Request body must be a JSON object', 'invalid_body');
  }
}

export function parseOptionalBoolean(body: JsonObject, field: string): boolean | undefined {
  if (!hasOwn(body, field)) return undefined;
  const value = body[field];
  if (typeof value !== 'boolean') {
    throw new BadRequestError(`${field} must be a boolean`, 'invalid_body');
  }
  return value;
}

export function parseOptionalStringMap(body: JsonObject, field: string): Record<string, string> | undefined {
  if (!hasOwn(body, field)) return undefined;
  const value = body[field];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== 'string')
  ) {
    throw new BadRequestError(`${field} must be an object with string values`, 'invalid_body');
  }
  return value as Record<string, string>;
}

export function parseOptionalNullableString(body: JsonObject, field: string): string | null | undefined {
  if (!hasOwn(body, field)) return undefined;
  const value = body[field];
  if (value !== null && typeof value !== 'string') {
    throw new BadRequestError(`${field} must be a string or null`, 'invalid_body');
  }
  return value;
}

export function parseOptionalPositiveInteger(
  body: JsonObject,
  field: string,
  options: { nullable?: boolean } = {}
): number | null | undefined {
  if (!hasOwn(body, field)) return undefined;
  const value = body[field];
  if (value === null && options.nullable) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BadRequestError(
      `${field} must be a positive safe integer${options.nullable ? ' or null' : ''}`,
      'invalid_body'
    );
  }
  return value;
}

export function parseOptionalServices(
  body: JsonObject,
  options: { nullable?: boolean } = {}
): EnvironmentServiceOverrideInput[] | null | undefined {
  if (!hasOwn(body, 'services')) return undefined;
  const value = body.services;
  if (value === null && options.nullable) return null;
  if (!Array.isArray(value)) {
    throw new BadRequestError(
      `services must be an array of service overrides${options.nullable ? ' or null' : ''}`,
      'invalid_body'
    );
  }

  const names = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BadRequestError(`services[${index}] must be a JSON object`, 'invalid_body');
    }
    const service = item as JsonObject;
    const unknownFields = Object.keys(service).filter(
      (key) => !(SERVICE_OVERRIDE_FIELDS as readonly string[]).includes(key)
    );
    if (unknownFields.length > 0) {
      throw new BadRequestError(
        `services[${index}] has unknown field${unknownFields.length > 1 ? 's' : ''} ${unknownFields
          .map((key) => `"${key}"`)
          .join(', ')}; allowed fields: ${SERVICE_OVERRIDE_FIELDS.join(', ')}.`,
        'invalid_body'
      );
    }
    if (typeof service.name !== 'string' || !service.name.trim()) {
      throw new BadRequestError(`services[${index}].name must be a non-empty string`, 'invalid_body');
    }
    if (names.has(service.name)) {
      throw new BadRequestError(`services must not contain duplicate name "${service.name}"`, 'invalid_body');
    }
    names.add(service.name);
    if (hasOwn(service, 'active') && typeof service.active !== 'boolean') {
      throw new BadRequestError(`services[${index}].active must be a boolean`, 'invalid_body');
    }
    if (hasOwn(service, 'branchOrExternalUrl') && typeof service.branchOrExternalUrl !== 'string') {
      throw new BadRequestError(`services[${index}].branchOrExternalUrl must be a string`, 'invalid_body');
    }

    return {
      name: service.name,
      ...(service.active !== undefined ? { active: service.active as boolean } : {}),
      ...(service.branchOrExternalUrl !== undefined
        ? { branchOrExternalUrl: service.branchOrExternalUrl as string }
        : {}),
    };
  });
}
