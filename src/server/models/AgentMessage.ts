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

export default class AgentMessage extends Model {
  uuid!: string;
  clientMessageId!: string | null;
  threadId!: number;
  runId!: number | null;
  role!: 'user' | 'assistant' | 'system' | 'tool';
  parts!: Array<Record<string, unknown>>;
  uiMessage!: Record<string, unknown> | null;
  metadata!: Record<string, unknown>;

  static tableName = 'agent_messages';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['threadId', 'role'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F-]{36}$',
      },
      threadId: { type: 'integer' },
      clientMessageId: { type: ['string', 'null'] },
      runId: { type: ['integer', 'null'] },
      role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
      parts: { type: 'array', items: { type: 'object' }, default: [] },
      uiMessage: { type: ['object', 'null'] },
      metadata: { type: 'object', default: {} },
    },
  };

  static get jsonAttributes() {
    return ['parts', 'uiMessage', 'metadata'];
  }

  static get relationMappings() {
    const AgentThread = require('./AgentThread').default;
    const AgentRun = require('./AgentRun').default;

    return {
      thread: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentThread,
        join: {
          from: 'agent_messages.threadId',
          to: 'agent_threads.id',
        },
      },
      run: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentRun,
        join: {
          from: 'agent_messages.runId',
          to: 'agent_runs.id',
        },
      },
    };
  }
}
