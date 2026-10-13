/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const count = { type: 'integer', minimum: 0 };
const bytes = { type: 'number', minimum: 0 };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const array = (items: unknown) => ({ type: 'array', items });
const success = (name: string) => ({
  allOf: [ref('SuccessApiResponse'), { type: 'object', properties: { data: ref(name) }, required: ['data'] }],
});
const ownerKind = { type: 'string', enum: ['user', 'service_key', 'unresolved'] };
const visibility = { type: 'string', enum: ['private', 'public'] };
const publisher = {
  key: { type: 'string', description: 'Opaque publisher key; pass it back as the owner filter.' },
  label: { type: 'string' },
  ownerKind,
};

export const sitesAnalyticsSchemas = {
  SitesAnalyticsActivity: object({
    published: count,
    updates: count,
    publishers: count,
    private: count,
    public: count,
  }),
  SitesAnalyticsPublisher: object(publisher),
  SitesAnalyticsSummary: object({
    range: ref('AnalyticsRange'),
    asOf: { type: 'string', format: 'date-time' },
    caveats: array({ type: 'string' }),
    config: object({
      ttlEnabled: { type: 'boolean' },
      defaultTtlDays: count,
      extensionDays: count,
      deletedRetentionDays: count,
    }),
    auditSince: { type: 'string', format: 'date-time', nullable: true },
    totals: ref('SitesAnalyticsActivity'),
    previous: { nullable: true, allOf: [ref('SitesAnalyticsActivity')] },
    series: array(
      object({
        date: { type: 'string', format: 'date' },
        previousDate: { type: 'string', format: 'date', nullable: true },
        current: ref('SitesAnalyticsActivity'),
        previous: { nullable: true, allOf: [ref('SitesAnalyticsActivity')] },
      })
    ),
    ownerKinds: object({ user: count, service_key: count, unresolved: count }),
    current: object({
      live: count,
      expiringSoon: count,
      noExpiry: count,
      storageBytes: bytes,
      liveBytes: bytes,
      restorable: count,
      expiredRecently: count,
      purgedRecently: count,
    }),
    endings: object({ expired: count, deleted: count, purged: count, restored: count }),
    extensions: object({ sites: count, none: count, one: count, two: count, three: count, fourOrMore: count }),
    lifetime: object({
      ended: count,
      medianSeconds: { type: 'number', nullable: true },
      p90Seconds: { type: 'number', nullable: true },
      bins: array(
        object({
          bin: {
            type: 'string',
            enum: ['under_1h', '1_to_24h', '1_to_3d', '3_to_7d', '7_to_14d', '14_to_30d', '30d_plus'],
          },
          count,
        })
      ),
    }),
    publishers: object({
      items: array(
        object({
          ...publisher,
          published: count,
          updates: count,
          liveSites: count,
          liveBytes: bytes,
          lastActivityAt: { type: 'string', format: 'date-time', nullable: true },
        })
      ),
      total: count,
      limit: count,
    }),
    largest: array(
      object({
        siteId: { type: 'string' },
        name: { type: 'string' },
        owner: ref('SitesAnalyticsPublisher'),
        visibility,
        sizeBytes: bytes,
        fileCount: count,
        updates: count,
        expiresAt: { type: 'string', format: 'date-time', nullable: true },
      })
    ),
    publisherOptions: object({
      items: array(ref('SitesAnalyticsPublisher')),
      total: count,
      truncated: { type: 'boolean' },
    }),
  }),
  GetSitesAnalyticsSuccessResponse: success('SitesAnalyticsSummary'),
};
