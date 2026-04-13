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

import Model from './_Model';
import type {
  McpAuthConfig,
  McpDiscoveredTool,
  McpSharedConnectionConfig,
  McpTransportConfig,
} from 'server/services/ai/mcp/types';

export default class McpServerConfig extends Model {
  slug!: string;
  name!: string;
  description?: string | null;
  scope!: string;
  preset!: string | null;
  transport!: McpTransportConfig;
  sharedConfig!: McpSharedConnectionConfig;
  authConfig!: McpAuthConfig;
  enabled!: boolean;
  timeout!: number;
  sharedDiscoveredTools!: McpDiscoveredTool[];

  static tableName = 'mcp_server_configs';
  static timestamps = true;
  static deleteable = true;

  static get jsonAttributes() {
    return ['transport', 'sharedConfig', 'authConfig', 'sharedDiscoveredTools'];
  }
}
