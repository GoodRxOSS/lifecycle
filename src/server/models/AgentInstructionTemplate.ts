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

export type AgentInstructionTemplateEffectiveSource = 'default' | 'override';

export default class AgentInstructionTemplate extends Model {
  ref!: string;
  name!: string;
  description!: string | null;
  defaultContent!: string;
  defaultVersion!: number;
  defaultHash!: string;
  overrideContent!: string | null;
  overrideVersion!: number | null;
  overrideHash!: string | null;
  overrideBaseDefaultVersion!: number | null;
  overrideBaseDefaultHash!: string | null;
  overrideUpdatedBy!: string | null;
  overrideUpdatedAt!: string | null;

  static tableName = 'agent_instruction_templates';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['ref', 'name', 'defaultContent', 'defaultVersion', 'defaultHash'],
    properties: {
      id: { type: 'integer' },
      ref: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
      description: { type: ['string', 'null'] },
      defaultContent: { type: 'string', minLength: 1 },
      defaultVersion: { type: 'integer', minimum: 1 },
      defaultHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      overrideContent: { type: ['string', 'null'] },
      overrideVersion: { type: ['integer', 'null'], minimum: 1 },
      overrideHash: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
      overrideBaseDefaultVersion: { type: ['integer', 'null'], minimum: 1 },
      overrideBaseDefaultHash: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
      overrideUpdatedBy: { type: ['string', 'null'] },
      overrideUpdatedAt: { type: ['string', 'null'] },
    },
  };

  get hasOverride(): boolean {
    return typeof this.overrideContent === 'string';
  }

  get effectiveSource(): AgentInstructionTemplateEffectiveSource {
    return this.hasOverride ? 'override' : 'default';
  }

  get effectiveContent(): string {
    return this.overrideContent ?? this.defaultContent;
  }

  get effectiveVersion(): number {
    return this.overrideVersion ?? this.defaultVersion;
  }

  get effectiveHash(): string {
    return this.overrideHash ?? this.defaultHash;
  }
}
