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

export type TelemetrySource = 'cli' | 'ui';
export type TelemetryStatus = 'success' | 'error';
export type TelemetryAttributeValue = string | number | boolean | string[];
export type TelemetryAttributes = Record<string, TelemetryAttributeValue>;

export default class TelemetryEvent extends Model {
  source!: TelemetrySource;
  clientId!: string;
  event!: string;
  attributes!: TelemetryAttributes;
  durationMs?: number | null;
  status!: TelemetryStatus;
  exitCode?: number | null;
  errorClass?: string | null;
  errorHttpStatus?: number | null;
  errorCode?: string | null;
  clientVersion!: string;
  runtimeVersion?: string | null;
  platform?: string | null;
  arch?: string | null;

  static tableName = 'telemetry_events';
  // Timestamps come from the table's CURRENT_TIMESTAMP defaults: stats bucketing
  // compares createdAt against now() in SQL, and the app-side getUtcTimestamp()
  // writes naive UTC strings that Postgres misreads on non-UTC hosts.
  static timestamps = false;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['source', 'clientId', 'event', 'status', 'clientVersion'],
    properties: {
      id: { type: 'integer' },
      source: { type: 'string', enum: ['cli', 'ui'] },
      clientId: {
        type: 'string',
        pattern: '^[0-9a-fA-F-]{36}$',
      },
      event: { type: 'string', minLength: 1, maxLength: 200 },
      attributes: { type: 'object', default: {} },
      durationMs: { type: ['integer', 'null'], minimum: 0 },
      status: { type: 'string', enum: ['success', 'error'] },
      exitCode: { type: ['integer', 'null'] },
      errorClass: { type: ['string', 'null'] },
      errorHttpStatus: { type: ['integer', 'null'] },
      errorCode: { type: ['string', 'null'] },
      clientVersion: { type: 'string', minLength: 1 },
      runtimeVersion: { type: ['string', 'null'] },
      platform: { type: ['string', 'null'] },
      arch: { type: ['string', 'null'] },
    },
  };

  static get jsonAttributes() {
    return ['attributes'];
  }
}
