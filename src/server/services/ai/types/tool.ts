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

export enum ToolSafetyLevel {
  SAFE = 'safe',
  CAUTIOUS = 'cautious',
  DANGEROUS = 'dangerous',
}

export type ToolCategory = 'k8s' | 'github' | 'codefresh' | 'database';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

export interface TextDisplay {
  type: 'text';
  content: string;
}

export interface TableDisplay {
  type: 'table';
  headers: string[];
  rows: string[][];
}

export interface DiffDisplay {
  type: 'diff';
  before: string;
  after: string;
}

export interface TerminalDisplay {
  type: 'terminal';
  output: string;
}

export type DisplayContent = TextDisplay | TableDisplay | DiffDisplay | TerminalDisplay;

export interface ToolError {
  message: string;
  code: string;
  details?: unknown;
  recoverable: boolean;
  suggestedAction?: string;
}

export interface ToolResult {
  success: boolean;
  agentContent?: string;
  displayContent?: DisplayContent;
  error?: ToolError;
}

export interface ConfirmationDetails {
  title: string;
  description: string;
  impact: string;
  confirmButtonText: string;
  onConfirm?(): Promise<void>;
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
  safetyLevel: ToolSafetyLevel;
  category: ToolCategory;

  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;

  shouldConfirmExecution?(args: Record<string, unknown>): Promise<ConfirmationDetails | false>;
}
