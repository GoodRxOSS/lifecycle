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
    visibility: { type: 'string', enum: ['private', 'public'] },
    contentUrl: { type: 'string', format: 'uri', minLength: 1, maxLength: 2048 },
    openUrl: { type: 'string', format: 'uri', minLength: 1, maxLength: 2048 },
    accessRevision: { type: 'integer', minimum: 1 },
    contentRevision: { type: 'integer', minimum: 1 },
    currentRole: { type: ['string', 'null'], enum: ['owner', null] },
    permissions: closedObjectSchema(
      {
        canView: { type: 'boolean' },
        canEdit: { type: 'boolean' },
        canDelete: { type: 'boolean' },
        canChangeVisibility: { type: 'boolean' },
      },
      ['canView', 'canEdit', 'canDelete', 'canChangeVisibility']
    ),
    status: { type: 'string', minLength: 1, maxLength: 50 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    fileCount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sizeBytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    createdBy: { type: 'string', minLength: 1, maxLength: 512 },
    updatedBy: { type: 'string', minLength: 1, maxLength: 512 },
  },
  [
    'siteId',
    'name',
    'url',
    'status',
    'createdAt',
    'updatedAt',
    'fileCount',
    'sizeBytes',
    'visibility',
    'contentUrl',
    'openUrl',
    'accessRevision',
    'contentRevision',
    'currentRole',
    'permissions',
  ]
);

export const listSitesInputSchema = closedObjectSchema({
  mineOnly: {
    type: 'boolean',
    description: 'Return only sites owned by the authenticated Lifecycle principal.',
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

const visibilitySchema = { type: 'string', enum: ['private', 'public'] } as const;
const revisionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;

const contentSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 3_000_000,
} as const;

const filenameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  default: 'index.html',
  description:
    'File name whose extension sets the content type: .html, .md, .markdown, .txt, .json, .csv, .xml, or .svg.',
} as const;

const siteChangeSchema = closedObjectSchema(
  {
    siteId: { type: 'string', minLength: 1, maxLength: 100 },
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    status: { type: 'string', maxLength: 50 },
    visibility: visibilitySchema,
    accessRevision: revisionSchema,
    contentRevision: revisionSchema,
    expiresAt: { type: 'string', format: 'date-time' },
  },
  ['siteId', 'url', 'status', 'visibility', 'accessRevision', 'contentRevision']
);

const siteResultSchema = successObjectSchema({ site: siteChangeSchema }, ['site']);

export const createSiteInputSchema = closedObjectSchema(
  {
    content: contentSchema,
    filename: filenameSchema,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    visibility: visibilitySchema,
  },
  ['content']
);

export const createSiteOutputSchema = siteResultSchema;

export const updateSiteContentInputSchema = closedObjectSchema(
  {
    siteId: siteIdSchema,
    content: contentSchema,
    filename: filenameSchema,
    expectedContentRevision: revisionSchema,
  },
  ['siteId', 'content']
);

export const updateSiteContentOutputSchema = siteResultSchema;

export const setSiteVisibilityInputSchema = closedObjectSchema(
  {
    siteId: siteIdSchema,
    visibility: visibilitySchema,
    expectedAccessRevision: revisionSchema,
  },
  ['siteId', 'visibility', 'expectedAccessRevision']
);

export const setSiteVisibilityOutputSchema = siteResultSchema;

export const extendSiteInputSchema = closedObjectSchema(
  {
    siteId: siteIdSchema,
    expectedAccessRevision: revisionSchema,
  },
  ['siteId']
);

export const extendSiteOutputSchema = siteResultSchema;

export const deleteSiteInputSchema = closedObjectSchema(
  {
    siteId: siteIdSchema,
    expectedAccessRevision: revisionSchema,
  },
  ['siteId', 'expectedAccessRevision']
);

export const deleteSiteOutputSchema = siteResultSchema;
