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

import type { StructuredDebugResponse, EvidenceItem, ServiceInvestigationResult } from './types';

export function computeCost(
  inputTokens: number,
  outputTokens: number,
  inputCostPerMillion?: number,
  outputCostPerMillion?: number
): number | null {
  if (inputCostPerMillion == null || outputCostPerMillion == null) return null;
  return (inputTokens * inputCostPerMillion + outputTokens * outputCostPerMillion) / 1_000_000;
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || durationMs === null) return '';

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = (durationMs / 1000).toFixed(1);
  return `${seconds}s`;
}

export function extractJsonContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) return trimmed;

  if (trimmed.startsWith('```')) {
    const stripped = trimmed
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?\s*```\s*$/, '')
      .trim();
    if (stripped.startsWith('{')) return stripped;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) {
    const extracted = fenceMatch[1].trim();
    if (extracted.startsWith('{')) return extracted;
  }

  const jsonIdx = trimmed.indexOf('{"type"');
  if (jsonIdx >= 0) return trimmed.substring(jsonIdx);

  const altIdx = trimmed.indexOf('{\n');
  if (altIdx >= 0 && trimmed.substring(altIdx).includes('"type"')) {
    return trimmed.substring(altIdx);
  }

  return trimmed;
}

export function parseStructuredResponse(content: string): StructuredDebugResponse | null {
  try {
    const cleaned = extractJsonContent(content);

    if (!cleaned.startsWith('{')) {
      return null;
    }

    const parsed = JSON.parse(cleaned);

    if (parsed.type === 'investigation_complete' && Array.isArray(parsed.services)) {
      return {
        ...parsed,
        fixesApplied: parsed.fixesApplied ?? false,
      } as StructuredDebugResponse;
    }

    return null;
  } catch (error) {
    return null;
  }
}

interface SingleLineFix {
  type: 'single-line';
  oldValue: string;
  newValue: string;
  file: string;
}

interface MultiLineFix {
  type: 'multi-line';
  description: string;
  startLine: number | undefined;
  endLine: number | undefined;
  file: string | null;
  currentLines: string[];
  shouldBeLines: string[];
}

export function parseSuggestedFix(suggestedFix: string): SingleLineFix | MultiLineFix | null {
  if (!suggestedFix) return null;
  const match = suggestedFix.match(/from '([^']+)' to '([^']+)' in ([\w/.+-]+\.\w+)/);
  if (match) {
    return {
      type: 'single-line' as const,
      oldValue: match[1],
      newValue: match[2],
      file: match[3].trim().replace(/[.,;:!]+$/, ''),
    };
  }

  const currentMatch = suggestedFix.match(/Current \(incorrect\):\s*([\s\S]*?)Should be:\s*([\s\S]*?)$/);
  if (currentMatch) {
    const headerMatch = suggestedFix.match(/^(.*?)(?:at lines? (\d+)(?:-(\d+))?)? in ([\w/.+-]+\.\w+)/);

    return {
      type: 'multi-line' as const,
      description: headerMatch ? headerMatch[1].trim() : '',
      startLine: headerMatch && headerMatch[2] ? parseInt(headerMatch[2]) : undefined,
      endLine:
        headerMatch && headerMatch[3]
          ? parseInt(headerMatch[3])
          : headerMatch && headerMatch[2]
          ? parseInt(headerMatch[2])
          : undefined,
      file: headerMatch ? headerMatch[4].trim().replace(/[.,;:!]+$/, '') : null,
      currentLines: currentMatch[1].trim().split('\n'),
      shouldBeLines: currentMatch[2].trim().split('\n'),
    };
  }

  return null;
}

export function getFollowUpSuggestions(messages: { role: string; content: string }[]): string[] {
  if (messages.length === 0) return [];

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== 'assistant') return [];

  const structured = parseStructuredResponse(lastMessage.content);
  if (!structured) return [];

  const suggestions: string[] = [];

  if (structured.fixesApplied) {
    suggestions.push('Check if the deployment is healthy now');
    suggestions.push('Verify the fix was applied correctly');
  }

  for (const service of structured.services) {
    if (service.status === 'build_failed') {
      suggestions.push(`Show me the build logs for ${service.serviceName}`);
    }
    if (service.status === 'deploy_failed') {
      suggestions.push(`Check pod status for ${service.serviceName}`);
    }
    if (service.status === 'error') {
      suggestions.push(`Check pod logs for ${service.serviceName}`);
    }
  }

  if (suggestions.length === 0 && structured.services.length > 0) {
    suggestions.push('Give me more details about the root cause');
    suggestions.push('What else can I check?');
  }

  return suggestions.slice(0, 3);
}

export function buildGitHubUrl(
  repository: { owner: string; name: string; branch: string; sha?: string },
  filePath: string,
  lineStart?: number,
  lineEnd?: number
): string {
  const ref = repository.sha || repository.branch;
  const base = `https://github.com/${repository.owner}/${repository.name}/blob/${ref}/${filePath}`;
  if (!lineStart) return base;
  const lineFragment = lineEnd && lineEnd !== lineStart ? `#L${lineStart}-L${lineEnd}` : `#L${lineStart}`;
  return base + lineFragment;
}

export function deduplicateItems(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    let key: string;
    if (item.type === 'evidence_file') {
      key = `file:${item.filePath || ''}:${item.repository || ''}`;
    } else if (item.type === 'evidence_commit') {
      key = `commit:${item.commitUrl || ''}`;
    } else {
      key = `resource:${item.resourceType || ''}/${item.resourceName || ''}:${item.namespace || ''}`;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matchEvidenceToServices(
  evidence: EvidenceItem[],
  services: ServiceInvestigationResult[]
): Map<string, EvidenceItem[]> {
  const deduplicated = deduplicateItems(evidence);
  const result = new Map<string, EvidenceItem[]>();

  for (const service of services) {
    result.set(service.serviceName, []);
  }

  for (const item of deduplicated) {
    let matched = false;

    if (item.filePath) {
      for (const service of services) {
        if (
          service.filePath === item.filePath ||
          (service.files && service.files.some((f) => f.path === item.filePath))
        ) {
          result.get(service.serviceName)!.push(item);
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    if (item.commitUrl) {
      for (const service of services) {
        if (service.commitUrl === item.commitUrl) {
          result.get(service.serviceName)!.push(item);
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    if (item.resourceName) {
      for (const service of services) {
        if (service.serviceName && item.resourceName.toLowerCase().includes(service.serviceName.toLowerCase())) {
          result.get(service.serviceName)!.push(item);
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    if (services.length > 0) {
      result.get(services[0].serviceName)!.push(item);
    }
  }

  return result;
}
