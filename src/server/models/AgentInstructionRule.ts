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

export default class AgentInstructionRule extends Model {
  agentRef!: string;
  repositoryFullName!: string | null;
  content!: string;
  position!: number;
  updatedBy!: string | null;

  static tableName = 'agent_instruction_rules';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['agentRef', 'content'],
    properties: {
      id: { type: 'integer' },
      agentRef: { type: 'string', minLength: 1 },
      repositoryFullName: { type: ['string', 'null'] },
      content: { type: 'string', minLength: 1 },
      position: { type: 'integer', minimum: 0 },
      updatedBy: { type: ['string', 'null'] },
    },
  };
}
