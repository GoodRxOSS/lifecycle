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

import type { AIChatEvidenceEvent } from 'shared/types/aiChat';
import type { ToolResult } from '../types/tool';

export interface EvidenceExtractorContext {
  toolCallId: string;
  repositoryOwner?: string;
  repositoryName?: string;
  commitSha?: string;
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  py: 'python',
  go: 'go',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  md: 'markdown',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  sh: 'shell',
  css: 'css',
  html: 'html',
};

function inferLanguage(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  return EXTENSION_LANGUAGE_MAP[ext];
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function safeParse(content: unknown): Record<string, unknown> | null {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (content && typeof content === 'object') {
    return content as Record<string, unknown>;
  }
  return null;
}

export function extractEvidence(
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: ToolResult,
  context: EvidenceExtractorContext
): AIChatEvidenceEvent[] {
  try {
    if (!result.success) return [];

    switch (toolName) {
      case 'get_file': {
        const parsed = safeParse(result.agentContent);
        const filePath = String((parsed && parsed.path) || toolArgs.file_path || '');
        const repository = `${toolArgs.repository_owner || ''}/${toolArgs.repository_name || ''}`;
        const branch = toolArgs.branch ? String(toolArgs.branch) : undefined;
        return [
          {
            type: 'evidence_file',
            toolCallId: context.toolCallId,
            filePath,
            repository,
            branch,
            language: inferLanguage(filePath),
          },
        ];
      }

      case 'update_file': {
        const parsed = safeParse(result.agentContent);
        const events: AIChatEvidenceEvent[] = [];

        if (parsed && parsed.commit_sha && parsed.commit_url) {
          events.push({
            type: 'evidence_commit',
            toolCallId: context.toolCallId,
            commitUrl: String(parsed.commit_url),
            commitMessage: String(toolArgs.commit_message || ''),
            filePaths: [String(toolArgs.file_path || '')],
          });
        }

        events.push({
          type: 'evidence_file',
          toolCallId: context.toolCallId,
          filePath: String(toolArgs.file_path || ''),
          repository: `${toolArgs.repository_owner || ''}/${toolArgs.repository_name || ''}`,
          branch: toolArgs.branch ? String(toolArgs.branch) : undefined,
        });

        return events;
      }

      case 'get_k8s_resources':
      case 'get_pod_logs':
      case 'patch_k8s_resource':
      case 'get_lifecycle_logs': {
        let resourceType: string;
        let resourceName: string;

        if (toolName === 'get_pod_logs') {
          resourceType = 'pod';
          resourceName = String(toolArgs.pod_name || '');
        } else {
          resourceType = String(toolArgs.resource_type || 'unknown');
          resourceName = String(toolArgs.name || '');
        }

        return [
          {
            type: 'evidence_resource',
            toolCallId: context.toolCallId,
            resourceType,
            resourceName,
            namespace: String(toolArgs.namespace || ''),
          },
        ];
      }

      default:
        return [];
    }
  } catch {
    return [];
  }
}

export function generateResultPreview(
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: ToolResult
): string | undefined {
  try {
    if (!result.success) return undefined;

    const parsed = safeParse(result.agentContent);

    switch (toolName) {
      case 'get_file': {
        if (!parsed) return undefined;
        const path = String(parsed.path || toolArgs.file_path || '');
        const content = parsed.content;
        const lineCount = typeof content === 'string' ? content.split('\n').length : 0;
        return truncate(`${path} (${lineCount} lines)`, 100);
      }

      case 'update_file': {
        const message = String((parsed && parsed.message) || toolArgs.commit_message || '');
        return truncate(`Committed: ${message}`, 100);
      }

      case 'get_k8s_resources': {
        if (!parsed) return undefined;
        if (Array.isArray(parsed.pods)) {
          const total = parsed.pods.length;
          const phases: Record<string, number> = {};
          for (const pod of parsed.pods as Array<Record<string, unknown>>) {
            const phase = String(pod.phase || 'Unknown');
            phases[phase] = (phases[phase] || 0) + 1;
          }
          const phaseSummary = Object.entries(phases)
            .map(([p, c]) => `${c} ${p}`)
            .join(', ');
          return truncate(`${total} pods: ${phaseSummary}`, 100);
        }
        if (Array.isArray(parsed.items)) {
          return truncate(`${parsed.items.length} ${toolArgs.resource_type || 'resources'} found`, 100);
        }
        return undefined;
      }

      case 'get_pod_logs': {
        if (!parsed) return undefined;
        const logContent = String(parsed.logs || parsed.content || '');
        const lineCount = logContent ? logContent.split('\n').length : 0;
        return truncate(`${lineCount} log lines from ${toolArgs.pod_name || 'pod'}`, 100);
      }

      case 'query_database': {
        if (!parsed) return undefined;
        if (Array.isArray(parsed.rows)) {
          return truncate(`${parsed.rows.length} rows returned`, 100);
        }
        return undefined;
      }

      case 'patch_k8s_resource': {
        return truncate(`Patched ${toolArgs.resource_type || 'resource'}/${toolArgs.name || ''}`, 100);
      }

      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
