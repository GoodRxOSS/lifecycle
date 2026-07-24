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

export const sitesConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'domain', 'port', 'hostPrefix', 'ttl', 'upload', 'storage', 'cleanup'],
  properties: {
    enabled: { type: 'boolean' },
    domain: { type: 'string', minLength: 1 },
    port: { type: ['integer', 'null'], minimum: 1, maximum: 65535 },
    hostPrefix: { type: 'string', minLength: 1 },
    ttl: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'defaultDays', 'extensionDays'],
      properties: {
        enabled: { type: 'boolean' },
        defaultDays: { type: 'integer', minimum: 1 },
        extensionDays: { type: 'integer', minimum: 1 },
      },
    },
    upload: {
      type: 'object',
      additionalProperties: false,
      required: ['maxUploadBytes', 'maxExtractedBytes', 'maxFiles', 'allowedExtensions'],
      properties: {
        maxUploadBytes: { type: 'integer', minimum: 1 },
        maxExtractedBytes: { type: 'integer', minimum: 1 },
        maxFiles: { type: 'integer', minimum: 1 },
        allowedExtensions: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1, pattern: '^\\.?[A-Za-z0-9][A-Za-z0-9.+-]*$' },
        },
        allowedTypes: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1, pattern: '^\\.?[A-Za-z0-9][A-Za-z0-9.+-]*$' },
        },
      },
    },
    storage: {
      type: 'object',
      additionalProperties: false,
      required: ['backend', 'bucket', 'prefix', 'region', 'endpoint', 'forcePathStyle'],
      properties: {
        backend: { type: 'string', enum: ['s3', 'minio'] },
        bucket: { type: 'string', minLength: 1 },
        prefix: { type: 'string' },
        region: { type: 'string', minLength: 1 },
        endpoint: { type: ['string', 'null'] },
        forcePathStyle: { type: ['boolean', 'null'] },
      },
    },
    cleanup: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'intervalMinutes'],
      properties: {
        enabled: { type: 'boolean' },
        intervalMinutes: { type: 'integer', minimum: 1 },
      },
    },
  },
};
