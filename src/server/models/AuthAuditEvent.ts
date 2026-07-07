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

export default class AuthAuditEvent extends Model {
  event!: string;
  principalKind!: string;
  principalId!: string | null;
  actorId!: string | null;
  tokenId!: number | null;
  requestId!: string | null;
  route!: string | null;
  outcome!: string;
  meta!: Record<string, unknown> | null;

  static tableName = 'auth_audit_events';

  static get jsonAttributes() {
    return ['meta'];
  }

  static jsonSchema = {
    type: 'object',
    required: ['event', 'principalKind', 'outcome'],
    properties: {
      id: { type: 'integer' },
      createdAt: { type: 'string' },
      event: { type: 'string', minLength: 1, maxLength: 255 },
      principalKind: { type: 'string', minLength: 1, maxLength: 32 },
      principalId: { type: ['string', 'null'] },
      actorId: { type: ['string', 'null'] },
      tokenId: { type: ['integer', 'null'] },
      requestId: { type: ['string', 'null'] },
      route: { type: ['string', 'null'] },
      outcome: { type: 'string', minLength: 1, maxLength: 32 },
      meta: { type: ['object', 'null'] },
    },
  };
}
