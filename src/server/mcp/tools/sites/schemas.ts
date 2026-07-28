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

import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';

export const siteIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Za-z0-9_-]+$',
  description: 'Hosted site id returned by list_sites.',
} as const;

const siteSummarySchema = closedObjectSchema(
  {
    siteId: siteIdSchema,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    url: { type: 'string', format: 'uri', minLength: 1, maxLength: 2048 },
    status: { type: 'string', minLength: 1, maxLength: 50 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    fileCount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sizeBytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    createdBy: { type: 'string', minLength: 1, maxLength: 512 },
    updatedBy: { type: 'string', minLength: 1, maxLength: 512 },
  },
  ['siteId', 'name', 'url', 'status', 'createdAt', 'updatedAt', 'fileCount', 'sizeBytes']
);

export const listSitesInputSchema = closedObjectSchema({
  mineOnly: {
    type: 'boolean',
    description: 'Return only sites created or updated by the authenticated Lifecycle user.',
  },
  cursor: { type: 'string', maxLength: 500 },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
});

export const listSitesOutputSchema = successObjectSchema(
  {
    sites: { type: 'array', minItems: 0, maxItems: 100, items: siteSummarySchema },
    nextCursor: { type: 'string', maxLength: 500 },
  },
  ['sites']
);

export const getSiteInputSchema = closedObjectSchema({ siteId: siteIdSchema }, ['siteId']);

export const getSiteOutputSchema = successObjectSchema({ site: siteSummarySchema }, ['site']);
