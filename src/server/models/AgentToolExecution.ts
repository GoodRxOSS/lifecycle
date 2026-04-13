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

export default class AgentToolExecution extends Model {
  uuid!: string;
  threadId!: number;
  runId!: number;
  pendingActionId!: number | null;
  source!: string;
  serverSlug!: string | null;
  toolName!: string;
  toolCallId!: string | null;
  args!: Record<string, unknown>;
  result!: Record<string, unknown> | null;
  status!: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  safetyLevel!: string | null;
  approved!: boolean | null;
  startedAt!: string | null;
  completedAt!: string | null;
  durationMs!: number | null;

  static tableName = 'agent_tool_executions';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['threadId', 'runId', 'source', 'toolName', 'args'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      },
      threadId: { type: 'integer' },
      runId: { type: 'integer' },
      pendingActionId: { type: ['integer', 'null'] },
      source: { type: 'string' },
      serverSlug: { type: ['string', 'null'] },
      toolName: { type: 'string' },
      toolCallId: { type: ['string', 'null'] },
      args: { type: 'object' },
      result: { type: ['object', 'null'], default: null },
      status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued' },
      safetyLevel: { type: ['string', 'null'] },
      approved: { type: ['boolean', 'null'] },
      startedAt: { type: ['string', 'null'] },
      completedAt: { type: ['string', 'null'] },
      durationMs: { type: ['integer', 'null'] },
    },
  };

  static get jsonAttributes() {
    return ['args', 'result'];
  }

  static get relationMappings() {
    const AgentThread = require('./AgentThread').default;
    const AgentRun = require('./AgentRun').default;
    const AgentPendingAction = require('./AgentPendingAction').default;

    return {
      thread: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentThread,
        join: {
          from: 'agent_tool_executions.threadId',
          to: 'agent_threads.id',
        },
      },
      run: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentRun,
        join: {
          from: 'agent_tool_executions.runId',
          to: 'agent_runs.id',
        },
      },
      pendingAction: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentPendingAction,
        join: {
          from: 'agent_tool_executions.pendingActionId',
          to: 'agent_pending_actions.id',
        },
      },
    };
  }
}
