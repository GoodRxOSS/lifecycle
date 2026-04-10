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

export default class AgentThread extends Model {
  uuid!: string;
  sessionId!: number;
  title!: string | null;
  isDefault!: boolean;
  archivedAt!: string | null;
  lastRunAt!: string | null;
  metadata!: Record<string, unknown>;

  static tableName = 'agent_threads';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['sessionId'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      },
      sessionId: { type: 'integer' },
      title: { type: ['string', 'null'] },
      isDefault: { type: 'boolean', default: false },
      archivedAt: { type: ['string', 'null'] },
      lastRunAt: { type: ['string', 'null'] },
      metadata: { type: 'object', default: {} },
    },
  };

  static get jsonAttributes() {
    return ['metadata'];
  }

  static get relationMappings() {
    const AgentSession = require('./AgentSession').default;
    const AgentRun = require('./AgentRun').default;
    const AgentMessage = require('./AgentMessage').default;
    const AgentPendingAction = require('./AgentPendingAction').default;

    return {
      session: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentSession,
        join: {
          from: 'agent_threads.sessionId',
          to: 'agent_sessions.id',
        },
      },
      runs: {
        relation: Model.HasManyRelation,
        modelClass: AgentRun,
        join: {
          from: 'agent_threads.id',
          to: 'agent_runs.threadId',
        },
      },
      messages: {
        relation: Model.HasManyRelation,
        modelClass: AgentMessage,
        join: {
          from: 'agent_threads.id',
          to: 'agent_messages.threadId',
        },
      },
      pendingActions: {
        relation: Model.HasManyRelation,
        modelClass: AgentPendingAction,
        join: {
          from: 'agent_threads.id',
          to: 'agent_pending_actions.threadId',
        },
      },
    };
  }
}
