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

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Principal } from 'server/lib/principal';

export type McpJsonPrimitive = string | number | boolean | null;
export type McpJsonValue = McpJsonPrimitive | McpJsonObject | McpJsonValue[];
export interface McpJsonObject {
  [key: string]: McpJsonValue;
}

export interface McpObjectSchema extends Record<string, unknown> {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false | Record<string, unknown>;
}

export type McpCapabilityId =
  | 'understand-environments'
  | 'diagnose-environments'
  | 'manage-environments'
  | 'view-hosted-sites';

export type McpToolAccess = 'read' | 'change';

export interface LifecycleMcpConfig {
  enabled: boolean;
  allowChanges: boolean;
}

export interface McpRuntimePolicy extends LifecycleMcpConfig {
  sitesAvailable: boolean;
}

export interface McpAdminTool {
  name: string;
  description: string;
  access: McpToolAccess;
}

export interface McpAdminCapability {
  id: McpCapabilityId;
  label: string;
  description: string;
  tools: McpAdminTool[];
}

export interface McpToolAuditFields {
  uuid?: string;
  environmentId?: number;
  deployId?: string;
  siteId?: string;
  idempotencyKeyFingerprint?: string;
  operation?: 'preview' | 'execute';
}

export interface McpToolAuditContext {
  /** Add safe identifiers learned after authorization; raw idempotency keys and confirmation tokens are never accepted. */
  annotate(fields: Partial<McpToolAuditFields>): void;
}

export interface McpToolContext {
  principal: Principal;
  requestId: string;
  signal: AbortSignal;
  audit: McpToolAuditContext;
}

export type McpToolInvocationContext = Omit<McpToolContext, 'audit'>;

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: McpObjectSchema;
  outputSchema: McpObjectSchema;
  annotations: ToolAnnotations;
  capabilityId: McpCapabilityId;
  access: McpToolAccess;
  handler: (input: McpJsonObject, context: McpToolContext) => McpJsonObject | Promise<McpJsonObject>;
}

export interface McpSuccessResult {
  content: [{ type: 'text'; text: string }];
  structuredContent: McpJsonObject;
}
