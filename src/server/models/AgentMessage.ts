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
  threadId!: number;
  runId!: number | null;
  role!: 'user' | 'assistant' | 'system' | 'tool';
  uiMessage!: Record<string, unknown>;
  metadata!: Record<string, unknown>;

  static tableName = 'agent_messages';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['threadId', 'role', 'uiMessage'],
    properties: {
      id: { type: 'integer' },
      threadId: { type: 'integer' },
      runId: { type: ['integer', 'null'] },
      role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
      uiMessage: { type: 'object' },
      metadata: { type: 'object', default: {} },
    },
  };

  static get jsonAttributes() {
    return ['uiMessage', 'metadata'];
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
