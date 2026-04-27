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

export default class AgentRunEvent extends Model {
  uuid!: string;
  runId!: number;
  sequence!: number;
  eventType!: string;
  payload!: Record<string, unknown>;

  static tableName = 'agent_run_events';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['runId', 'sequence', 'eventType'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F-]{36}$',
      },
      runId: { type: 'integer' },
      sequence: { type: 'integer' },
      eventType: { type: 'string' },
      payload: { type: 'object', default: {} },
    },
  };

  static get jsonAttributes() {
    return ['payload'];
  }

  static get relationMappings() {
    const AgentRun = require('./AgentRun').default;

    return {
      run: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentRun,
        join: {
          from: 'agent_run_events.runId',
          to: 'agent_runs.id',
        },
      },
    };
  }
}
