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

export interface TextDisplay {
  type: 'text';
  content: string;
}

export type DisplayContent = TextDisplay;

export interface ToolError {
  message: string;
  code: string;
  details?: unknown;
}

export interface ToolAuthProvenance {
  provider: string;
  source: string;
  required: boolean;
  githubUsername?: string | null;
}

export interface ToolResult {
  success: boolean;
  agentContent: string;
  displayContent?: DisplayContent;
  error?: ToolError;
  auth?: ToolAuthProvenance;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  items?: any;
  enum?: any[];
  description?: string;
  [key: string]: any;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;

  execute(args: Record<string, unknown>, signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolExecutionContext {
  toolCallId?: string | null;
}
