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

export interface ActivityLog {
  type: string;
  message: string;
  status?: 'pending' | 'completed' | 'failed';
  details?: {
    toolDurationMs?: number;
    totalDurationMs?: number;
  };
  toolCallId?: string;
  resultPreview?: string;
}

export interface EvidenceItem {
  type: 'evidence_file' | 'evidence_commit' | 'evidence_resource';
  toolCallId: string;
  filePath?: string;
  repository?: string;
  branch?: string;
  language?: string;
  lineStart?: number;
  lineEnd?: number;
  commitUrl?: string;
  commitMessage?: string;
  filePaths?: string[];
  resourceType?: string;
  resourceName?: string;
  namespace?: string;
  status?: string;
}

export interface DebugMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  isSystemAction?: boolean;
  stopped?: boolean;
  failed?: boolean;
  activityHistory?: ActivityLog[];
  evidenceItems?: EvidenceItem[];
  totalInvestigationTimeMs?: number;
}

export interface FileChange {
  path: string;
  lineNumber?: number;
  lineNumberEnd?: number;
  description?: string;
  oldContent?: string;
  newContent?: string;
}

export interface ServiceInvestigationResult {
  serviceName: string;
  status: 'build_failed' | 'deploy_failed' | 'error' | 'ready' | string;
  issue: string;
  keyError?: string;
  errorSource?: string;
  errorSourceDetail?: string;
  suggestedFix: string;
  canAutoFix?: boolean;
  filePath?: string;
  lineNumber?: number;
  lineNumberEnd?: number;
  files?: FileChange[];
  commitUrl?: string;
}

export interface StructuredDebugResponse {
  type: 'investigation_complete';
  summary: string;
  fixesApplied: boolean;
  services: ServiceInvestigationResult[];
  repository?: {
    owner: string;
    name: string;
    branch: string;
    sha?: string;
  };
}

export interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
  default: boolean;
  maxTokens: number;
}
