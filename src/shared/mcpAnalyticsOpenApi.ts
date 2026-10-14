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
const nullableText = { type: 'string', nullable: true };
const nullableInstant = { type: 'string', format: 'date-time', nullable: true };
const milliseconds = { type: 'number', minimum: 0, nullable: true };
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

export const mcpAnalyticsSchemas = {
  McpAnalyticsTotals: object({
    calls: integer,
    errors: integer,
    errorRate: rate,
    users: integer,
    clients: { ...integer, description: 'Distinct registered client application names.' },
    installations: { ...integer, description: 'Distinct client registrations.' },
    readOnlyCalls: integer,
    changeCalls: integer,
  }),
  McpAnalyticsBucket: object({
    date: { type: 'string', format: 'date' },
    calls: integer,
    errors: integer,
    users: integer,
    previousCalls: nullableInteger,
    previousErrors: nullableInteger,
    previousUsers: nullableInteger,
  }),
  McpAnalyticsTool: object({
    tool: { type: 'string' },
    readOnly: { type: 'boolean', nullable: true, description: 'Null when only older records exist for the tool.' },
    calls: integer,
    errors: integer,
    errorRate: rate,
    p50DurationMs: milliseconds,
    p95DurationMs: milliseconds,
  }),
  McpAnalyticsUser: object({
    userId: nullableText,
    username: nullableText,
    calls: integer,
    errors: integer,
    lastCallAt: nullableInstant,
  }),
  McpAnalyticsClient: object({
    client: {
      type: 'string',
      description: 'Registered client application name, or Unregistered client / Unknown client.',
    },
    installations: integer,
    calls: integer,
    users: integer,
    errors: integer,
    lastCallAt: nullableInstant,
  }),
  McpAnalytics: object({
    range: ref('AnalyticsRange'),
    asOf: { type: 'string', format: 'date-time' },
    caveats: array({ type: 'string' }),
    auditSince: { ...nullableInstant, description: 'First recorded MCP call.' },
    allCallsSince: { ...nullableInstant, description: 'First call recorded with read-only calls included.' },
    totals: ref('McpAnalyticsTotals'),
    previousTotals: nullableRef('McpAnalyticsTotals'),
    buckets: array(ref('McpAnalyticsBucket')),
    tools: array(ref('McpAnalyticsTool')),
    users: object({ items: array(ref('McpAnalyticsUser')), total: integer, limit: integer }),
    clients: array(ref('McpAnalyticsClient')),
    errors: array(object({ code: { type: 'string' }, calls: integer })),
  }),
  GetMcpAnalyticsSuccessResponse: success('McpAnalytics'),
  McpAnalyticsCallTarget: object({
    environmentUuid: nullableText,
    environmentId: nullableInteger,
    siteId: nullableText,
    deployId: nullableText,
  }),
  McpAnalyticsCall: object({
    id: integer,
    createdAt: { type: 'string', format: 'date-time' },
    period: { type: 'string', enum: ['current', 'previous'] },
    tool: { type: 'string' },
    readOnly: { type: 'boolean', nullable: true },
    outcome: { type: 'string', description: 'succeeded or the recorded error code.' },
    error: { type: 'boolean' },
    durationMs: milliseconds,
    userId: nullableText,
    username: nullableText,
    client: { type: 'string', description: 'Client application name as the summary shows it.' },
    clientId: { ...nullableText, description: 'OAuth client registration ID of the installation.' },
    requestId: nullableText,
    target: nullableRef('McpAnalyticsCallTarget'),
  }),
  McpAnalyticsCallsSlice: object({
    tool: nullableText,
    userId: nullableText,
    client: nullableText,
    outcome: nullableText,
    date: { type: 'string', format: 'date', nullable: true },
    period: { type: 'string', enum: ['current', 'previous'] },
    sort: { type: 'string' },
  }),
  McpAnalyticsCalls: object({
    range: ref('AnalyticsRange'),
    asOf: { type: 'string', format: 'date-time' },
    caveats: array({ type: 'string' }),
    slice: ref('McpAnalyticsCallsSlice'),
    records: array(ref('McpAnalyticsCall')),
    pagination: ref('EnvironmentAnalyticsPagination'),
  }),
  GetMcpAnalyticsCallsSuccessResponse: success('McpAnalyticsCalls'),
};
