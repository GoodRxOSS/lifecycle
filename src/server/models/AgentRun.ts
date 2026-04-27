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

import Model from './_Model';

export default class AgentRun extends Model {
  uuid!: string;
  threadId!: number;
  sessionId!: number;
  status!:
    | 'queued'
    | 'starting'
    | 'running'
    | 'waiting_for_approval'
    | 'waiting_for_input'
    | 'completed'
    | 'failed'
    | 'cancelled';
  requestedHarness!: string | null;
  resolvedHarness!: string | null;
  requestedProvider!: string | null;
  requestedModel!: string | null;
  resolvedProvider!: string | null;
  resolvedModel!: string | null;
  sandboxRequirement!: Record<string, unknown>;
  sandboxGeneration!: number | null;
  executionOwner!: string | null;
  leaseExpiresAt!: string | null;
  heartbeatAt!: string | null;
  provider!: string;
  model!: string;
  queuedAt!: string;
  startedAt!: string | null;
  completedAt!: string | null;
  cancelledAt!: string | null;
  usageSummary!: Record<string, unknown>;
  policySnapshot!: Record<string, unknown>;
  error!: Record<string, unknown> | null;

  static tableName = 'agent_runs';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['threadId', 'sessionId', 'provider', 'model'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      },
      threadId: { type: 'integer' },
      sessionId: { type: 'integer' },
      status: {
        type: 'string',
        enum: [
          'queued',
          'starting',
          'running',
          'waiting_for_approval',
          'waiting_for_input',
          'completed',
          'failed',
          'cancelled',
        ],
      },
      requestedHarness: { type: ['string', 'null'] },
      resolvedHarness: { type: ['string', 'null'] },
      requestedProvider: { type: ['string', 'null'] },
      requestedModel: { type: ['string', 'null'] },
      resolvedProvider: { type: ['string', 'null'] },
      resolvedModel: { type: ['string', 'null'] },
      sandboxRequirement: { type: 'object', default: {} },
      sandboxGeneration: { type: ['integer', 'null'] },
      executionOwner: { type: ['string', 'null'] },
      leaseExpiresAt: { type: ['string', 'null'] },
      heartbeatAt: { type: ['string', 'null'] },
      provider: { type: 'string' },
      model: { type: 'string' },
      queuedAt: { type: 'string' },
      startedAt: { type: ['string', 'null'] },
      completedAt: { type: ['string', 'null'] },
      cancelledAt: { type: ['string', 'null'] },
      usageSummary: { type: 'object', default: {} },
      policySnapshot: { type: 'object', default: {} },
      error: { type: ['object', 'null'], default: null },
    },
  };

  static get jsonAttributes() {
    return ['sandboxRequirement', 'usageSummary', 'policySnapshot', 'error'];
  }

  static get relationMappings() {
    const AgentThread = require('./AgentThread').default;
    const AgentSession = require('./AgentSession').default;
    const AgentMessage = require('./AgentMessage').default;
    const AgentPendingAction = require('./AgentPendingAction').default;
    const AgentToolExecution = require('./AgentToolExecution').default;
    const AgentRunEvent = require('./AgentRunEvent').default;

    return {
      thread: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentThread,
        join: {
          from: 'agent_runs.threadId',
          to: 'agent_threads.id',
        },
      },
      session: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentSession,
        join: {
          from: 'agent_runs.sessionId',
          to: 'agent_sessions.id',
        },
      },
      messages: {
        relation: Model.HasManyRelation,
        modelClass: AgentMessage,
        join: {
          from: 'agent_runs.id',
          to: 'agent_messages.runId',
        },
      },
      pendingActions: {
        relation: Model.HasManyRelation,
        modelClass: AgentPendingAction,
        join: {
          from: 'agent_runs.id',
          to: 'agent_pending_actions.runId',
        },
      },
      toolExecutions: {
        relation: Model.HasManyRelation,
        modelClass: AgentToolExecution,
        join: {
          from: 'agent_runs.id',
          to: 'agent_tool_executions.runId',
        },
      },
      events: {
        relation: Model.HasManyRelation,
        modelClass: AgentRunEvent,
        join: {
          from: 'agent_runs.id',
          to: 'agent_run_events.runId',
        },
      },
    };
  }
}
