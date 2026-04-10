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

export default class AgentPendingAction extends Model {
  uuid!: string;
  threadId!: number;
  runId!: number;
  kind!: string;
  status!: 'pending' | 'approved' | 'denied';
  capabilityKey!: string;
  title!: string;
  description!: string;
  payload!: Record<string, unknown>;
  resolution!: Record<string, unknown> | null;
  resolvedAt!: string | null;

  static tableName = 'agent_pending_actions';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['threadId', 'runId', 'kind', 'capabilityKey', 'title', 'description'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      },
      threadId: { type: 'integer' },
      runId: { type: 'integer' },
      kind: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'approved', 'denied'], default: 'pending' },
      capabilityKey: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      payload: { type: 'object', default: {} },
      resolution: { type: ['object', 'null'], default: null },
      resolvedAt: { type: ['string', 'null'] },
    },
  };

  static get jsonAttributes() {
    return ['payload', 'resolution'];
  }

  static get relationMappings() {
    const AgentThread = require('./AgentThread').default;
    const AgentRun = require('./AgentRun').default;
    const AgentToolExecution = require('./AgentToolExecution').default;

    return {
      thread: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentThread,
        join: {
          from: 'agent_pending_actions.threadId',
          to: 'agent_threads.id',
        },
      },
      run: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentRun,
        join: {
          from: 'agent_pending_actions.runId',
          to: 'agent_runs.id',
        },
      },
      toolExecutions: {
        relation: Model.HasManyRelation,
        modelClass: AgentToolExecution,
        join: {
          from: 'agent_pending_actions.id',
          to: 'agent_tool_executions.pendingActionId',
        },
      },
    };
  }
}
