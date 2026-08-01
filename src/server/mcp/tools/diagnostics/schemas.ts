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

import type { McpObjectSchema } from '../../contracts';
import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';

const uuidSchema = { type: 'string', minLength: 1, maxLength: 63 };
const environmentIdSchema = { type: 'integer', minimum: 1 };
const serviceNameSchema = { type: 'string', minLength: 1, maxLength: 100 };
const jobNameSchema = { type: 'string', minLength: 1, maxLength: 253 };
const boundedTextSchema = { type: 'string', maxLength: 2_500 };

const buildLogSourceInput = closedObjectSchema(
  {
    kind: { type: 'string', const: 'build' },
    jobName: jobNameSchema,
  },
  ['kind']
);
const deployLogSourceInput = closedObjectSchema(
  {
    kind: { type: 'string', const: 'deploy' },
    jobName: jobNameSchema,
  },
  ['kind']
);
const runtimeLogSourceInput = closedObjectSchema(
  {
    kind: { type: 'string', const: 'runtime' },
    container: { type: 'string', minLength: 1, maxLength: 253 },
    previous: { type: 'boolean' },
  },
  ['kind']
);
const tailRetrievalInput = closedObjectSchema(
  {
    mode: { type: 'string', const: 'tail' },
    tailLines: { type: 'integer', minimum: 1, maximum: 2_000 },
  },
  ['mode']
);
const searchRetrievalInput = closedObjectSchema(
  {
    mode: { type: 'string', const: 'search' },
    text: { type: 'string', minLength: 1, maxLength: 256 },
    contextLines: { type: 'integer', minimum: 0, maximum: 5 },
  },
  ['mode', 'text']
);
const windowRetrievalInput = closedObjectSchema(
  {
    mode: { type: 'string', const: 'window' },
    startLine: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: '1-based line number within the fetched log window.',
    },
    maxLines: { type: 'integer', minimum: 1, maximum: 500 },
  },
  ['mode', 'startLine', 'maxLines']
);

export const getLogsInputSchema: McpObjectSchema = closedObjectSchema(
  {
    uuid: uuidSchema,
    service: serviceNameSchema,
    source: {
      oneOf: [buildLogSourceInput, deployLogSourceInput, runtimeLogSourceInput],
    },
    retrieval: {
      oneOf: [tailRetrievalInput, searchRetrievalInput, windowRetrievalInput],
    },
  },
  ['uuid', 'service', 'source', 'retrieval']
);

const buildLogSourceOutput = closedObjectSchema(
  {
    kind: { type: 'string', const: 'build' },
    jobName: jobNameSchema,
    jobStatus: {
      type: 'string',
      enum: ['Active', 'Complete', 'Failed', 'Pending'],
    },
  },
  ['kind', 'jobName', 'jobStatus']
);
const deployLogSourceOutput = closedObjectSchema(
  {
    kind: { type: 'string', const: 'deploy' },
    jobName: jobNameSchema,
    jobStatus: {
      type: 'string',
      enum: ['Active', 'Complete', 'Failed', 'Pending'],
    },
  },
  ['kind', 'jobName', 'jobStatus']
);
const runtimeLogSourceOutput = closedObjectSchema(
  {
    kind: { type: 'string', const: 'runtime' },
    podName: { type: 'string', minLength: 1, maxLength: 253 },
    container: { type: 'string', minLength: 1, maxLength: 253 },
  },
  ['kind', 'podName', 'container']
);

const totalLinesSchema = {
  type: 'integer',
  minimum: 0,
  description: 'Line count of the fetched log window, not of the full source log.',
};
const truncatedSchema = {
  type: 'boolean',
  description: 'True when the fetched window or its rendering was reduced. Older log content may exist upstream.',
};

const tailLinesOutput = closedObjectSchema(
  {
    mode: { type: 'string', const: 'tail' },
    content: { type: 'string', maxLength: 30_720 },
    totalLines: totalLinesSchema,
    truncated: truncatedSchema,
    note: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
  ['mode', 'content', 'totalLines', 'truncated']
);
const searchLinesOutput = closedObjectSchema(
  {
    mode: { type: 'string', const: 'search' },
    content: { type: 'string', maxLength: 30_720 },
    totalLines: totalLinesSchema,
    matchCount: { type: 'integer', minimum: 0, description: 'Matches within the fetched log window.' },
    truncated: truncatedSchema,
    note: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
  ['mode', 'content', 'totalLines', 'matchCount', 'truncated']
);
const windowLinesOutput = closedObjectSchema(
  {
    mode: { type: 'string', const: 'window' },
    content: { type: 'string', maxLength: 30_720 },
    totalLines: totalLinesSchema,
    startLine: { type: 'integer', minimum: 1, description: '1-based line number within the fetched log window.' },
    endLine: { type: 'integer', minimum: 0 },
    truncated: truncatedSchema,
    note: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
  ['mode', 'content', 'totalLines', 'startLine', 'endLine', 'truncated']
);

export const getLogsOutputSchema: McpObjectSchema = successObjectSchema(
  {
    uuid: uuidSchema,
    environmentId: environmentIdSchema,
    service: serviceNameSchema,
    source: {
      oneOf: [buildLogSourceOutput, deployLogSourceOutput, runtimeLogSourceOutput],
    },
    logSource: { type: 'string', enum: ['live', 'archived'] },
    lines: {
      oneOf: [tailLinesOutput, searchLinesOutput, windowLinesOutput],
    },
    untrusted: { type: 'boolean', const: true },
  },
  ['uuid', 'environmentId', 'service', 'source', 'logSource', 'lines', 'untrusted']
);

const suggestedGetLogs = closedObjectSchema(
  {
    tool: { type: 'string', const: 'get_logs' },
    args: getLogsInputSchema,
  },
  ['tool', 'args']
);
const failureEvidence = closedObjectSchema(
  {
    untrusted: { type: 'boolean', const: true },
    podSummary: { type: 'string', maxLength: 2_000 },
    warningEvents: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', maxLength: 1_000 },
    },
    logTail: boundedTextSchema,
  },
  ['untrusted']
);
const failingService = closedObjectSchema(
  {
    name: serviceNameSchema,
    failurePhase: {
      type: 'string',
      enum: ['image_build', 'deploy', 'runtime', 'config', 'blocked'],
    },
    statusMessage: { type: 'string', maxLength: 1_000 },
    evidence: failureEvidence,
    suggested: {
      type: 'array',
      maxItems: 3,
      items: suggestedGetLogs,
    },
  },
  ['name', 'failurePhase']
);

export const diagnoseEnvironmentInputSchema: McpObjectSchema = closedObjectSchema(
  {
    uuid: uuidSchema,
    services: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: serviceNameSchema,
    },
  },
  ['uuid']
);

export const diagnoseEnvironmentOutputSchema: McpObjectSchema = successObjectSchema(
  {
    uuid: uuidSchema,
    environmentId: environmentIdSchema,
    status: { type: 'string', minLength: 1, maxLength: 100 },
    phase: {
      type: 'string',
      enum: ['ready', 'deployed_not_ready', 'in_progress', 'paused', 'failed', 'tearing_down', 'torn_down'],
    },
    verdict: { type: 'string', minLength: 1, maxLength: 500 },
    config: closedObjectSchema(
      {
        status: { type: 'string', enum: ['valid', 'invalid', 'unknown'] },
        message: { type: 'string', maxLength: 1_000 },
      },
      ['status']
    ),
    failingServices: {
      type: 'array',
      maxItems: 4,
      items: failingService,
    },
    healthyServices: {
      type: 'array',
      maxItems: 200,
      uniqueItems: true,
      items: serviceNameSchema,
    },
    notes: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
    },
  },
  ['uuid', 'environmentId', 'status', 'phase', 'verdict', 'config', 'failingServices', 'healthyServices', 'notes']
);

export const getKubernetesStateInputSchema: McpObjectSchema = closedObjectSchema(
  {
    uuid: uuidSchema,
    view: { type: 'string', enum: ['pods', 'events'] },
    service: serviceNameSchema,
  },
  ['uuid', 'view']
);

const podContainer = closedObjectSchema(
  {
    name: { type: 'string', minLength: 1, maxLength: 253 },
    state: {
      type: 'string',
      enum: ['waiting', 'running', 'terminated', 'unknown'],
    },
    reason: { type: 'string', maxLength: 200 },
    restarts: { type: 'integer', minimum: 0 },
  },
  ['name', 'state', 'restarts']
);
const podRow = closedObjectSchema(
  {
    name: { type: 'string', minLength: 1, maxLength: 253 },
    service: { type: 'string', maxLength: 100 },
    status: { type: 'string', minLength: 1, maxLength: 100 },
    ready: { type: 'string', pattern: '^\\d+/\\d+$', maxLength: 30 },
    restarts: { type: 'integer', minimum: 0 },
    ageSeconds: { type: 'integer', minimum: 0 },
    containers: { type: 'array', maxItems: 20, items: podContainer },
  },
  ['name', 'service', 'status', 'ready', 'restarts', 'ageSeconds', 'containers']
);
const eventRow = closedObjectSchema(
  {
    type: { type: 'string', minLength: 1, maxLength: 100 },
    reason: { type: 'string', minLength: 1, maxLength: 200 },
    object: { type: 'string', minLength: 1, maxLength: 500 },
    message: { type: 'string', maxLength: 1_000 },
    count: { type: 'integer', minimum: 0 },
    lastSeen: { type: 'string', format: 'date-time' },
  },
  ['type', 'reason', 'object', 'message', 'count']
);
const podsResult = closedObjectSchema(
  {
    view: { type: 'string', const: 'pods' },
    pods: { type: 'array', maxItems: 100, items: podRow },
    truncated: { type: 'boolean', description: 'True when more pods exist than are listed.' },
  },
  ['view', 'pods', 'truncated']
);
const eventsResult = closedObjectSchema(
  {
    view: { type: 'string', const: 'events' },
    events: { type: 'array', maxItems: 60, items: eventRow },
    truncated: { type: 'boolean', description: 'True when more events exist than are listed.' },
  },
  ['view', 'events', 'truncated']
);

export const getKubernetesStateOutputSchema: McpObjectSchema = successObjectSchema(
  {
    uuid: uuidSchema,
    environmentId: environmentIdSchema,
    result: { oneOf: [podsResult, eventsResult] },
    untrusted: { type: 'boolean', const: true },
  },
  ['uuid', 'environmentId', 'result', 'untrusted']
);
