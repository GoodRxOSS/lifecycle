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
const nullableNumber = { type: 'number', nullable: true };
const nullableString = { type: 'string', nullable: true };
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
const statuses = [
  'queued',
  'starting',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'transitioned',
  'completed',
  'failed',
  'cancelled',
  'unknown',
];
const totals = object({ repositories: count, owners: count, models: count });
const truncated = object({
  repositories: { type: 'boolean' },
  owners: { type: 'boolean' },
  models: { type: 'boolean' },
});
const metricProperties = {
  runs: count,
  sessions: count,
  owners: count,
  outcomes: object(Object.fromEntries(statuses.map((status) => [status, count]))),
  tokens: object({
    total: nullableNumber,
    input: nullableNumber,
    output: nullableNumber,
    reportedRuns: count,
    inputReportedRuns: count,
    outputReportedRuns: count,
    missingRuns: count,
    pendingRuns: count,
  }),
  reportedCost: object({ usd: nullableNumber, coveredRuns: count }),
  estimatedCost: object({ usd: nullableNumber, coveredRuns: count }),
  unattributedRuns: count,
};

export const agentAnalyticsSchemas = {
  AgentAnalyticsMetrics: object(metricProperties),
  AgentAnalyticsSummary: object({
    range: ref('AnalyticsRange'),
    asOf: { type: 'string', format: 'date-time' },
    attribution: object({
      repository: { type: 'string', enum: ['run_plan_primary'] },
      model: { type: 'string', enum: ['current_resolved'] },
      repositoryScope: { type: 'string', enum: ['recorded_name'] },
    }),
    caveats: array({ type: 'string' }),
    totals: ref('AgentAnalyticsMetrics'),
    previous: { nullable: true, allOf: [ref('AgentAnalyticsMetrics')] },
    series: array(
      object({
        date: { type: 'string', format: 'date' },
        previousDate: { type: 'string', format: 'date', nullable: true },
        current: ref('AgentAnalyticsMetrics'),
        previous: { nullable: true, allOf: [ref('AgentAnalyticsMetrics')] },
      })
    ),
    repositories: array(object({ repository: nullableString, ...metricProperties })),
    models: array(object({ provider: { type: 'string' }, model: { type: 'string' }, ...metricProperties })),
    definitions: array(object({ agentId: nullableString, label: nullableString, ...metricProperties })),
    sessionsCreated: object({
      current: count,
      previous: { ...count, nullable: true },
      unattributedCurrent: count,
      unattributedPrevious: { ...count, nullable: true },
      attribution: { type: 'string', enum: ['first_recorded_run'] },
    }),
    earliestRunAt: { type: 'string', format: 'date-time', nullable: true },
    rankingLimit: count,
    rankingTotal: object({ repositories: count, models: count, definitions: count }),
    rankingTruncated: object({
      repositories: { type: 'boolean' },
      models: { type: 'boolean' },
      definitions: { type: 'boolean' },
    }),
  }),
  AgentAnalyticsRun: object({
    runId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
    threadId: { type: 'string', format: 'uuid' },
    submittedAt: {
      type: 'string',
      format: 'date-time',
      description: 'Immutable run creation time used for submission cohorts and pagination.',
    },
    queuedAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'Latest queue time; can change when an approval resumes the run.',
    },
    status: { type: 'string', enum: statuses },
    repository: nullableString,
    provider: { type: 'string' },
    model: { type: 'string' },
    agentId: nullableString,
    agentLabel: nullableString,
    ownerId: { type: 'string' },
    ownerGithubUsername: nullableString,
    tokens: object({ total: nullableNumber, input: nullableNumber, output: nullableNumber }),
    reportedCostUsd: nullableNumber,
    estimatedCostUsd: nullableNumber,
    errorCode: nullableString,
  }),
  AgentAnalyticsRuns: object({
    range: ref('AnalyticsRange'),
    asOf: { type: 'string', format: 'date-time' },
    caveats: array({ type: 'string' }),
    runs: array(ref('AgentAnalyticsRun')),
    pagination: object({ page: count, limit: count, total: count, hasMore: { type: 'boolean' } }),
  }),
  AgentAnalyticsSession: object({
    ...metricProperties,
    sessionId: { type: 'string', format: 'uuid' },
    title: nullableString,
    ownerId: { type: 'string' },
    ownerGithubUsername: nullableString,
    sessionKind: { type: 'string' },
    sessionStatus: { type: 'string' },
    repositories: { ...array({ type: 'string' }), maxItems: 5 },
    repositoryCount: count,
    firstSubmittedAt: { type: 'string', format: 'date-time' },
    lastSubmittedAt: { type: 'string', format: 'date-time' },
  }),
  AgentAnalyticsSessions: object({
    range: ref('AnalyticsRange'),
    asOf: { type: 'string', format: 'date-time' },
    caveats: array({ type: 'string' }),
    sessions: array(ref('AgentAnalyticsSession')),
    pagination: object({ page: count, limit: count, total: count, hasMore: { type: 'boolean' } }),
  }),
  AgentAnalyticsOptions: object({
    asOf: { type: 'string', format: 'date-time' },
    repositoryScope: { type: 'string', enum: ['recorded_name'] },
    repositories: array({ type: 'string' }),
    hasUnattributed: { type: 'boolean' },
    owners: array(object({ id: { type: 'string' }, githubUsername: nullableString })),
    models: array(object({ provider: { type: 'string' }, model: { type: 'string' } })),
    limit: count,
    totals,
    truncated,
  }),
  GetAgentAnalyticsSuccessResponse: success('AgentAnalyticsSummary'),
  GetAgentAnalyticsRunsSuccessResponse: success('AgentAnalyticsRuns'),
  GetAgentAnalyticsSessionsSuccessResponse: success('AgentAnalyticsSessions'),
  GetAgentAnalyticsOptionsSuccessResponse: success('AgentAnalyticsOptions'),
};
