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

import { ToolResult, ConfirmationDetails } from './tool';

export interface ActivityEvent {
  type: 'tool_call' | 'thinking' | 'processing' | 'error';
  message: string;
  details?: unknown;
  timestamp: number;
}

export interface StructuredData {
  type: string;
  [key: string]: unknown;
}

export interface StreamCallbacks {
  onTextChunk(text: string): void;
  onThinking(message: string, details?: unknown): void;
  onToolCall(tool: string, args: unknown): void;
  onToolResult(
    result: ToolResult,
    toolName: string,
    toolArgs: unknown,
    toolDurationMs?: number,
    totalDurationMs?: number
  ): void;
  onStructuredOutput(data: StructuredData): void;
  onError(error: ToolResult['error']): void;
  onActivity(activity: ActivityEvent): void;
  onToolConfirmation?(details: ConfirmationDetails): Promise<boolean>;
}
