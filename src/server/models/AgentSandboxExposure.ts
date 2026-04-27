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

export default class AgentSandboxExposure extends Model {
  uuid!: string;
  sandboxId!: number;
  kind!: string;
  status!: 'provisioning' | 'ready' | 'failed' | 'ended';
  targetPort!: number | null;
  url!: string | null;
  metadata!: Record<string, unknown>;
  providerState!: Record<string, unknown>;
  lastVerifiedAt!: string | null;
  endedAt!: string | null;

  static tableName = 'agent_sandbox_exposures';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['sandboxId', 'kind', 'status'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F-]{36}$',
      },
      sandboxId: { type: 'integer' },
      kind: { type: 'string' },
      status: { type: 'string', enum: ['provisioning', 'ready', 'failed', 'ended'] },
      targetPort: { type: ['integer', 'null'] },
      url: { type: ['string', 'null'] },
      metadata: { type: 'object', default: {} },
      providerState: { type: 'object', default: {} },
      lastVerifiedAt: { type: ['string', 'null'] },
      endedAt: { type: ['string', 'null'] },
    },
  };

  static get jsonAttributes() {
    return ['metadata', 'providerState'];
  }

  static get relationMappings() {
    const AgentSandbox = require('./AgentSandbox').default;

    return {
      sandbox: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentSandbox,
        join: {
          from: 'agent_sandbox_exposures.sandboxId',
          to: 'agent_sandboxes.id',
        },
      },
    };
  }
}
