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

const integer = { type: 'integer', minimum: 0 };
const nullableInteger = { ...integer, nullable: true };
const text = { type: 'string' };
const nullableText = { ...text, nullable: true };
const instant = { type: 'string', format: 'date-time' };
const nullableInstant = { ...instant, nullable: true };
const hours = { type: 'number', minimum: 0, nullable: true };
const boolean = { type: 'boolean' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullableRef = (name: string) => ({ allOf: [ref(name)], nullable: true });
const array = (items: object) => ({ type: 'array', items });
const object = (properties: Record<string, object>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const success = (name: string) => ({
  allOf: [ref('SuccessApiResponse'), { type: 'object', properties: { data: ref(name) }, required: ['data'] }],
});
const method = { type: 'string', enum: ['created_to_deleted', 'created_to_last_update', 'first_record_age'] };
const quality = { type: 'string', enum: ['recorded', 'estimated', 'record_age'] };
const group = { type: 'string', enum: ['api', 'pr', 'other'] };
const bin = {
  type: 'string',
  enum: ['under_1h', '1_to_6h', '6_to_24h', '1_to_3d', '3_to_7d', '7_to_30d', '30d_plus', 'missing', 'invalid'],
  nullable: true,
};
const unplaced = object({ missingEnd: integer, invalidEnd: integer });

export const environmentLifetimeAnalyticsSchemas = {
  EnvironmentLifetimeDistribution: object({
    id: { type: 'string', enum: ['under_1h', '1_to_6h', '6_to_24h', '1_to_3d', '3_to_7d', '7_to_30d', '30d_plus'] },
    label: text,
    fromHours: { type: 'number', minimum: 0 },
    toHours: hours,
    count: integer,
  }),
  EnvironmentLifetimeStats: object({
    method,
    quality,
    eligible: integer,
    samples: integer,
    missing: integer,
    invalid: integer,
    meanHours: hours,
    medianHours: hours,
    p90Hours: hours,
    distribution: array(ref('EnvironmentLifetimeDistribution')),
  }),
  EnvironmentLifetimeCompleted: object({ api: ref('EnvironmentLifetimeStats'), pr: ref('EnvironmentLifetimeStats') }),
  EnvironmentLifetimeBucket: object({
    date: { type: 'string', format: 'date' },
    previousDate: { type: 'string', format: 'date', nullable: true },
    current: ref('EnvironmentLifetimeCompleted'),
    previous: nullableRef('EnvironmentLifetimeCompleted'),
  }),
  EnvironmentLifetimeAnalytics: object({
    range: ref('AnalyticsRange'),
    asOf: instant,
    scope: ref('EnvironmentAnalyticsScope'),
    completed: ref('EnvironmentLifetimeCompleted'),
    previousCompleted: nullableRef('EnvironmentLifetimeCompleted'),
    buckets: array(ref('EnvironmentLifetimeBucket')),
    currentAge: object({
      all: ref('EnvironmentLifetimeStats'),
      api: ref('EnvironmentLifetimeStats'),
      pr: ref('EnvironmentLifetimeStats'),
      other: ref('EnvironmentLifetimeStats'),
    }),
    unplacedRetirements: object({ api: unplaced, pr: unplaced, other: integer }),
    caveats: array(text),
  }),
  EnvironmentLifetimeRecord: object({
    id: integer,
    uuid: nullableText,
    status: nullableText,
    isStatic: boolean,
    author: nullableText,
    repositoryId: nullableInteger,
    fullName: nullableText,
    githubInstallationId: nullableInteger,
    repositoryAmbiguous: boolean,
    resourceAvailable: boolean,
    pullRequest: nullableRef('EnvironmentAnalyticsPullRequest'),
    group,
    method,
    quality,
    sampleState: { type: 'string', enum: ['valid', 'missing', 'invalid'] },
    startedAt: nullableInstant,
    measuredUntilAt: nullableInstant,
    durationHours: hours,
  }),
  EnvironmentLifetimeRecords: object({
    asOf: instant,
    scope: ref('EnvironmentAnalyticsScope'),
    range: nullableRef('AnalyticsRange'),
    cohort: { type: 'string', enum: ['completed', 'current'] },
    group: { type: 'string', enum: ['all', 'api', 'pr', 'other'] },
    bin,
    records: array(ref('EnvironmentLifetimeRecord')),
    pagination: object({
      page: { type: 'integer', minimum: 1, maximum: 10000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      total: integer,
      hasMore: boolean,
      maxPage: { type: 'integer', enum: [10000] },
      truncated: boolean,
    }),
    caveats: array(text),
  }),
  GetEnvironmentLifetimeAnalyticsSuccessResponse: success('EnvironmentLifetimeAnalytics'),
  GetEnvironmentLifetimeAnalyticsRecordsSuccessResponse: success('EnvironmentLifetimeRecords'),
};
