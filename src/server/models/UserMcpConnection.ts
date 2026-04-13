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
import type { McpDiscoveredTool } from 'server/services/ai/mcp/types';

export default class UserMcpConnection extends Model {
  userId!: string;
  ownerGithubUsername!: string;
  scope!: string;
  slug!: string;
  encryptedState!: string;
  definitionFingerprint!: string;
  discoveredTools!: McpDiscoveredTool[];
  validationError!: string | null;
  validatedAt!: string | null;

  static tableName = 'user_mcp_connections';
  static timestamps = true;

  static jsonAttributes = ['discoveredTools'];

  static jsonSchema = {
    type: 'object',
    required: ['userId', 'ownerGithubUsername', 'scope', 'slug', 'encryptedState', 'definitionFingerprint'],
    properties: {
      id: { type: 'integer' },
      userId: { type: 'string' },
      ownerGithubUsername: { type: 'string' },
      scope: { type: 'string' },
      slug: { type: 'string' },
      encryptedState: { type: 'string' },
      definitionFingerprint: { type: 'string' },
      discoveredTools: { type: 'array' },
      validationError: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      validatedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
  };
}
