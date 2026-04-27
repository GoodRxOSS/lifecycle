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

export default class AgentSource extends Model {
  uuid!: string;
  sessionId!: number;
  adapter!: string;
  status!: 'requested' | 'preparing' | 'ready' | 'failed' | 'cleaned_up';
  input!: Record<string, unknown>;
  preparedSource!: Record<string, unknown>;
  sandboxRequirements!: Record<string, unknown>;
  error!: Record<string, unknown> | null;
  preparedAt!: string | null;
  cleanedUpAt!: string | null;

  static tableName = 'agent_sources';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['sessionId', 'adapter', 'status'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F-]{36}$',
      },
      sessionId: { type: 'integer' },
      adapter: { type: 'string' },
      status: { type: 'string', enum: ['requested', 'preparing', 'ready', 'failed', 'cleaned_up'] },
      input: { type: 'object', default: {} },
      preparedSource: { type: 'object', default: {} },
      sandboxRequirements: { type: 'object', default: {} },
      error: { type: ['object', 'null'], default: null },
      preparedAt: { type: ['string', 'null'] },
      cleanedUpAt: { type: ['string', 'null'] },
    },
  };

  static get jsonAttributes() {
    return ['input', 'preparedSource', 'sandboxRequirements', 'error'];
  }

  static get relationMappings() {
    const AgentSession = require('./AgentSession').default;

    return {
      session: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentSession,
        join: {
          from: 'agent_sources.sessionId',
          to: 'agent_sessions.id',
        },
      },
    };
  }
}
