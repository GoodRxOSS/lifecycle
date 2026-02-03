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

export interface ChunkEvent {
  type: 'chunk';
  content: string;
}

export interface CompleteEvent {
  type: 'complete';
  totalInvestigationTimeMs: number;
}

export interface CompleteJsonEvent {
  type: 'complete_json';
  content: string;
  totalInvestigationTimeMs: number;
}

export interface ToolCallEvent {
  type: 'tool_call';
  message: string;
  toolCallId?: string;
}

export interface ProcessingEvent {
  type: 'processing';
  message: string;
  details?: {
    toolDurationMs?: number;
    totalDurationMs?: number;
  };
  resultPreview?: string;
  toolCallId?: string;
}

export interface ThinkingEvent {
  type: 'thinking';
  message: string;
}

export interface ActivityErrorEvent {
  type: 'error';
  message: string;
}

export interface EvidenceFileEvent {
  type: 'evidence_file';
  toolCallId: string;
  filePath: string;
  repository: string;
  branch?: string;
  lineStart?: number;
  lineEnd?: number;
  language?: string;
}

export interface EvidenceCommitEvent {
  type: 'evidence_commit';
  toolCallId: string;
  commitUrl: string;
  commitMessage: string;
  filePaths: string[];
}

export interface EvidenceResourceEvent {
  type: 'evidence_resource';
  toolCallId: string;
  resourceType: string;
  resourceName: string;
  namespace: string;
  status?: string;
}

export type AIChatEvidenceEvent = EvidenceFileEvent | EvidenceCommitEvent | EvidenceResourceEvent;

export interface SSEErrorEvent {
  error: true;
  userMessage: string;
  category: 'rate-limited' | 'transient' | 'deterministic' | 'ambiguous';
  suggestedAction: 'retry' | 'switch-model' | 'check-config' | null;
  retryAfter: number | null;
  modelName: string;
  code?: string;
}

export type AIChatActivityEvent = ToolCallEvent | ProcessingEvent | ThinkingEvent | ActivityErrorEvent;

export type AIChatSSEEvent = ChunkEvent | CompleteEvent | CompleteJsonEvent | AIChatActivityEvent | AIChatEvidenceEvent;

export function isEvidenceEvent(event: AIChatSSEEvent): event is AIChatEvidenceEvent {
  return event.type === 'evidence_file' || event.type === 'evidence_commit' || event.type === 'evidence_resource';
}
