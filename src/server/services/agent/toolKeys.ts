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

export const LIFECYCLE_BUILTIN_SERVER_SLUG = 'lifecycle';
export const LIFECYCLE_BUILTIN_SERVER_NAME = 'Lifecycle';
export const CHAT_REQUEST_WORKSPACE_TOOL_NAME = 'request_workspace';

export function buildAgentToolKey(serverSlug: string, toolName: string): string {
  return `mcp__${serverSlug}__${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}
