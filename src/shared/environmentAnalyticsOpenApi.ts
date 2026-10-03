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
const date = { type: 'string', format: 'date' };
const instant = { type: 'string', format: 'date-time' };
const nullableInstant = { ...instant, nullable: true };
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

const periodProperties = { from: date, to: date, fromUtc: instant, toUtc: instant, dates: array(date) };
const repositoryProperties = {
  repositoryId: nullableInteger,
  fullName: nullableText,
  githubInstallationId: nullableInteger,
};
const inventoryProperties = {
  current: integer,
  static: integer,
  ephemeral: integer,
  ready: integer,
  deployedNotReady: integer,
  inProgress: integer,
  paused: integer,
  failed: integer,
  tearingDown: integer,
  unattributed: integer,
  ambiguous: integer,
};
const phase = {
  type: 'string',
  enum: ['ready', 'deployed_not_ready', 'in_progress', 'paused', 'failed', 'tearing_down', 'torn_down'],
};

export const environmentAnalyticsSchemas = {
  AnalyticsPeriod: object(periodProperties),
  AnalyticsRange: object({
    ...periodProperties,
    timezone: text,
    interval: { type: 'string', enum: ['day', 'week'] },
    compare: boolean,
    calendarDays: { type: 'integer', minimum: 1, maximum: 365 },
    previous: nullableRef('AnalyticsPeriod'),
    asOf: instant,
  }),
  EnvironmentAnalyticsScope: object({
    repositoryId: nullableInteger,
    organization: nullableText,
    environmentType: { type: 'string', enum: ['all', 'ephemeral', 'static'] },
    environmentAuthor: nullableText,
    unattributed: boolean,
  }),
  EnvironmentAnalyticsTotals: object({
    firstSeenEnvironments: integer,
    observedPullRequests: nullableInteger,
    pullRequestsWithEnvironments: nullableInteger,
    activeRepositories: integer,
    unattributedEnvironments: integer,
    ambiguousRepositoryEnvironments: integer,
  }),
  EnvironmentAnalyticsRepository: object({
    ...repositoryProperties,
    firstSeenEnvironments: integer,
    observedPullRequests: nullableInteger,
    pullRequestsWithEnvironments: nullableInteger,
    pullRequestCoverage: { type: 'number', minimum: 0, maximum: 1, nullable: true },
    currentEnvironments: integer,
    readyEnvironments: integer,
  }),
  EnvironmentAnalyticsBucket: object({
    date,
    firstSeenEnvironments: integer,
    observedPullRequests: nullableInteger,
    previousFirstSeenEnvironments: nullableInteger,
    previousObservedPullRequests: nullableInteger,
  }),
  EnvironmentAnalyticsRetention: object({
    earliestRetainedEnvironmentAt: nullableInstant,
    earliestRetainedPullRequestAt: nullableInstant,
    collectionStartedAt: {
      ...nullableInstant,
      description: 'Unknown; earliest retained record is not collection start.',
    },
    retentionStartAt: {
      ...nullableInstant,
      description: 'Unknown; no retention completeness boundary is established.',
    },
  }),
  EnvironmentAnalytics: object({
    range: ref('AnalyticsRange'),
    scope: ref('EnvironmentAnalyticsScope'),
    retention: ref('EnvironmentAnalyticsRetention'),
    totals: ref('EnvironmentAnalyticsTotals'),
    previousTotals: nullableRef('EnvironmentAnalyticsTotals'),
    buckets: array(ref('EnvironmentAnalyticsBucket')),
    repositories: array(ref('EnvironmentAnalyticsRepository')),
    rankingTotal: integer,
    rankingTruncated: boolean,
    rankBy: { type: 'string', enum: ['first_seen', 'observed_prs', 'pr_coverage'] },
    caveats: array(text),
  }),
  InventoryAnalyticsTotals: object(inventoryProperties),
  InventoryAnalyticsRepository: object({ ...repositoryProperties, ...inventoryProperties }),
  EnvironmentAnalyticsPullRequest: object({ number: nullableInteger, title: nullableText, author: nullableText }),
  EnvironmentAnalyticsRecord: object({
    ...repositoryProperties,
    id: integer,
    uuid: nullableText,
    namespace: nullableText,
    status: nullableText,
    phase,
    isStatic: boolean,
    trigger: text,
    author: nullableText,
    createdAt: nullableInstant,
    updatedAt: nullableInstant,
    expiresAt: nullableInstant,
    deletedAt: nullableInstant,
    resourceAvailable: boolean,
    repositoryAmbiguous: boolean,
    pullRequest: nullableRef('EnvironmentAnalyticsPullRequest'),
  }),
  InventoryAnalytics: object({
    asOf: instant,
    scope: ref('EnvironmentAnalyticsScope'),
    totals: ref('InventoryAnalyticsTotals'),
    repositories: array(ref('InventoryAnalyticsRepository')),
    exceptions: array(ref('EnvironmentAnalyticsRecord')),
    truncated: boolean,
    repositoriesTruncated: boolean,
    repositoryTotal: integer,
    caveats: array(text),
  }),
  AnalyticsRepositoryOption: object({
    ...repositoryProperties,
    githubRepositoryId: integer,
    deletedAt: nullableInstant,
  }),
  AnalyticsOptions: object({
    repositories: array(ref('AnalyticsRepositoryOption')),
    organizations: array(text),
    environmentAuthors: array(text),
    truncated: object({ repositories: boolean, organizations: boolean, environmentAuthors: boolean }),
    caveats: array(text),
  }),
  EnvironmentAnalyticsPagination: object({
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    total: integer,
    hasMore: boolean,
  }),
  EnvironmentAnalyticsRecords: object({
    asOf: instant,
    scope: ref('EnvironmentAnalyticsScope'),
    range: nullableRef('AnalyticsRange'),
    cohort: { type: 'string', enum: ['first_seen', 'current'] },
    records: array(ref('EnvironmentAnalyticsRecord')),
    pagination: ref('EnvironmentAnalyticsPagination'),
  }),
  GetAnalyticsOptionsSuccessResponse: success('AnalyticsOptions'),
  GetEnvironmentAnalyticsSuccessResponse: success('EnvironmentAnalytics'),
  GetInventoryAnalyticsSuccessResponse: success('InventoryAnalytics'),
  GetEnvironmentAnalyticsRecordsSuccessResponse: success('EnvironmentAnalyticsRecords'),
};
