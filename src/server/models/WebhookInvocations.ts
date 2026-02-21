/**
 * Copyright 2025 GoodRx, Inc.
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

import { JSONSchema } from 'objection';
import Model from './_Model';
import Build from './Build';

export default class WebhookInvocations extends Model {
  buildId!: number;
  runUUID!: string;
  name!: string;
  type!: string; // could be enum
  state!: string;
  yamlConfig!: string;
  owner!: string; // could be enum?
  metadata!: Record<string, unknown>;
  status!: string;

  static tableName = 'webhook_invocations';
  static timestamps: boolean = true;

  static jsonSchema: JSONSchema = {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        default: 'codefresh',
      },
      owner: {
        type: 'string',
        default: 'build',
      },
    },
  };

  static relationMappings = {
    build: {
      relation: Model.BelongsToOneRelation,
      modelClass: () => Build,
      join: {
        from: 'webhook_invocations.buildId',
        to: 'builds.id',
      },
    },
  };

  static get jsonAttributes() {
    return ['metadata'];
  }
}
