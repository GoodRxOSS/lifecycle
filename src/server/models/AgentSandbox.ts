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

export default class AgentSandbox extends Model {
  uuid!: string;
  sessionId!: number;
  generation!: number;
  provider!: string;
  status!: 'provisioning' | 'ready' | 'suspending' | 'suspended' | 'resuming' | 'failed' | 'ended';
  capabilitySnapshot!: Record<string, unknown>;
  providerState!: Record<string, unknown>;
  metadata!: Record<string, unknown>;
  error!: Record<string, unknown> | null;
  suspendedAt!: string | null;
  endedAt!: string | null;

  static tableName = 'agent_sandboxes';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['sessionId', 'generation', 'provider', 'status'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F-]{36}$',
      },
      sessionId: { type: 'integer' },
      generation: { type: 'integer' },
      provider: { type: 'string' },
      status: {
        type: 'string',
        enum: ['provisioning', 'ready', 'suspending', 'suspended', 'resuming', 'failed', 'ended'],
      },
      capabilitySnapshot: { type: 'object', default: {} },
      providerState: { type: 'object', default: {} },
      metadata: { type: 'object', default: {} },
      error: { type: ['object', 'null'], default: null },
      suspendedAt: { type: ['string', 'null'] },
      endedAt: { type: ['string', 'null'] },
    },
  };

  static get jsonAttributes() {
    return ['capabilitySnapshot', 'providerState', 'metadata', 'error'];
  }

  static get relationMappings() {
    const AgentSession = require('./AgentSession').default;
    const AgentSandboxExposure = require('./AgentSandboxExposure').default;

    return {
      session: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentSession,
        join: {
          from: 'agent_sandboxes.sessionId',
          to: 'agent_sessions.id',
        },
      },
      exposures: {
        relation: Model.HasManyRelation,
        modelClass: AgentSandboxExposure,
        join: {
          from: 'agent_sandboxes.id',
          to: 'agent_sandbox_exposures.sandboxId',
        },
      },
    };
  }
}
