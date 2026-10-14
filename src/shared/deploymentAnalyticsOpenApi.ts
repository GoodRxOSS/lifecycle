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
const minutes = { type: 'number', minimum: 0, nullable: true };
const nullableText = { type: 'string', nullable: true };
const nullableInstant = { type: 'string', format: 'date-time', nullable: true };
const rate = { type: 'number', minimum: 0, maximum: 1, nullable: true };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullableRef = (name: string) => ({ allOf: [ref(name)], nullable: true });
const array = (items: unknown) => ({ type: 'array', items });
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const success = (name: string) => ({
  allOf: [ref('SuccessApiResponse'), { type: 'object', properties: { data: ref(name) }, required: ['data'] }],
});
const outcomeCounts = {
  requested: integer,
  succeeded: integer,
  failed: integer,
  successRate: { ...rate, description: 'Succeeded divided by succeeded plus failed; null without resolved requests.' },
};

export const deploymentAnalyticsSchemas = {
  DeploymentAnalyticsPercentiles: object({ samples: integer, p50Minutes: minutes, p90Minutes: minutes }),
  DeploymentAnalyticsTotals: object({
    ...outcomeCounts,
    claimed: integer,
    superseded: { ...integer, description: 'Requests replaced or stopped before their run finished.' },
    blocked: {
      ...integer,
      description: 'Requests that did not run because deploys were disabled.',
    },
    tornDown: { ...integer, description: 'Requests ended by a teardown.' },
    unresolved: { ...integer, description: 'Requests with no recorded outcome yet.' },
    timeToReady: ref('DeploymentAnalyticsPercentiles'),
    queueWait: ref('DeploymentAnalyticsPercentiles'),
  }),
  DeploymentAnalyticsBucket: object({
    date: { type: 'string', format: 'date' },
    requested: integer,
    succeeded: integer,
    failed: integer,
    previousRequested: nullableInteger,
    previousSucceeded: nullableInteger,
    previousFailed: nullableInteger,
  }),
  DeploymentAnalyticsRepository: object({
    repositoryId: nullableInteger,
    fullName: { type: 'string', nullable: true },
    githubInstallationId: nullableInteger,
    ...outcomeCounts,
    timeToReadyP50Minutes: minutes,
  }),
  DeploymentAnalyticsOrigin: object({
    origin: {
      type: 'string',
      enum: ['push', 'label', 'pr_open', 'config_push', 'api', 'redeploy', 'mcp', 'comment', 'agent', 'unknown'],
    },
    ...outcomeCounts,
  }),
  DeploymentAnalytics: object({
    range: ref('AnalyticsRange'),
    scope: ref('EnvironmentAnalyticsScope'),
    asOf: { type: 'string', format: 'date-time' },
    caveats: array({ type: 'string' }),
    collectionStartedAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'First recorded deploy request; null until one is recorded.',
    },
    totals: ref('DeploymentAnalyticsTotals'),
    previousTotals: nullableRef('DeploymentAnalyticsTotals'),
    buckets: array(ref('DeploymentAnalyticsBucket')),
    repositories: object({ items: array(ref('DeploymentAnalyticsRepository')), total: integer, limit: integer }),
    origins: array(ref('DeploymentAnalyticsOrigin')),
    failureReasons: object({
      items: array(object({ reason: { type: 'string' }, count: integer })),
      total: integer,
      limit: integer,
    }),
  }),
  GetDeploymentAnalyticsSuccessResponse: success('DeploymentAnalytics'),
  DeploymentAnalyticsServiceOutcome: object({
    name: { type: 'string' },
    type: nullableText,
    status: nullableText,
    outcome: { type: 'string', enum: ['ready', 'failed', 'unfinished'] },
    message: nullableText,
  }),
  DeploymentAnalyticsRequestRecord: object({
    requestId: { type: 'string' },
    id: { ...integer, description: 'Environment record ID.' },
    uuid: nullableText,
    namespace: nullableText,
    isStatic: { type: 'boolean' },
    resourceAvailable: { type: 'boolean' },
    pullRequest: nullableRef('EnvironmentAnalyticsPullRequest'),
    repositoryId: nullableInteger,
    fullName: nullableText,
    githubInstallationId: nullableInteger,
    origin: {
      type: 'string',
      enum: ['push', 'label', 'pr_open', 'config_push', 'api', 'redeploy', 'mcp', 'comment', 'agent', 'unknown'],
    },
    period: { type: 'string', enum: ['current', 'previous'] },
    requestedAt: { type: 'string', format: 'date-time' },
    outcome: { type: 'string', enum: ['succeeded', 'failed', 'superseded', 'blocked', 'torn_down', 'unresolved'] },
    claimedAt: nullableInstant,
    blockedAt: nullableInstant,
    supersededAt: nullableInstant,
    decidedAt: { ...nullableInstant, description: 'Time of the finish that decided the outcome.' },
    readyAt: { ...nullableInstant, description: 'First finish that reported every service ready.' },
    queueWaitMinutes: minutes,
    timeToReadyMinutes: minutes,
    services: nullableInteger,
    failed: nullableInteger,
    exitReason: { ...nullableText, description: 'Recorded code for a request that did not run or was stopped.' },
    reason: { ...nullableText, description: 'Recorded status message of the deciding finish.' },
    serviceOutcomes: { ...array(ref('DeploymentAnalyticsServiceOutcome')), nullable: true },
  }),
  DeploymentAnalyticsRequestsSlice: object({
    outcomes: array({
      type: 'string',
      enum: ['succeeded', 'failed', 'superseded', 'blocked', 'torn_down', 'unresolved'],
    }),
    origin: {
      type: 'string',
      enum: ['push', 'label', 'pr_open', 'config_push', 'api', 'redeploy', 'mcp', 'comment', 'agent', 'unknown'],
      nullable: true,
    },
    reason: nullableText,
    date: { type: 'string', format: 'date', nullable: true },
    period: { type: 'string', enum: ['current', 'previous'] },
    sort: { type: 'string' },
  }),
  DeploymentAnalyticsRequests: object({
    range: ref('AnalyticsRange'),
    scope: ref('EnvironmentAnalyticsScope'),
    asOf: { type: 'string', format: 'date-time' },
    caveats: array({ type: 'string' }),
    slice: ref('DeploymentAnalyticsRequestsSlice'),
    records: array(ref('DeploymentAnalyticsRequestRecord')),
    pagination: ref('EnvironmentAnalyticsPagination'),
  }),
  GetDeploymentAnalyticsRequestsSuccessResponse: success('DeploymentAnalyticsRequests'),
};
