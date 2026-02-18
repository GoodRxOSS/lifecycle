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

type Capability = 'file_write' | 'pr_label_write' | 'k8s_patch';

export interface FixTargetScope {
  serviceName?: string;
  suggestedFix?: string;
  filePath?: string;
  files?: Array<{ path?: string }>;
  autoFixAction?: string;
  actionType?: string;
  fixType?: string;
  tool?: string;
  toolName?: string;
}

export interface ToolAuthorizationInput {
  name: string;
  description: string;
  category: string;
  safetyLevel: string;
  args: Record<string, unknown>;
}

export interface ToolAuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

const SINGLE_LINE_FIX_PATTERN = /from '([^']+)' to '([^']+)' in ([\w/.+-]+\.\w+)/i;
const PR_LABEL_MUTATION_PATTERN = /\b(add|apply|set|remove|update|edit)\b/i;
const PR_LABEL_CONTEXT_PATTERN = /\b(pr|pull[\s-]?request)\b/i;
const LABEL_PATTERN = /\blabels?\b/i;

function isPrLabelFix(target: FixTargetScope): boolean {
  const fix = target.suggestedFix || '';
  return (
    fix.length > 0 &&
    PR_LABEL_MUTATION_PATTERN.test(fix) &&
    LABEL_PATTERN.test(fix) &&
    PR_LABEL_CONTEXT_PATTERN.test(fix)
  );
}

function detectCapabilities(target: FixTargetScope): Set<Capability> {
  const capabilities = new Set<Capability>();
  const explicitHints = [target.autoFixAction, target.actionType, target.fixType, target.tool, target.toolName]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ')
    .toLowerCase();

  if (explicitHints.includes('label') && (explicitHints.includes('pr') || explicitHints.includes('pull'))) {
    capabilities.add('pr_label_write');
  }
  if (
    explicitHints.includes('patch_k8s') ||
    (explicitHints.includes('k8s') && explicitHints.includes('patch')) ||
    (explicitHints.includes('kubernetes') && explicitHints.includes('patch'))
  ) {
    capabilities.add('k8s_patch');
  }
  if (
    explicitHints.includes('update_file') ||
    explicitHints.includes('commit_lifecycle_fix') ||
    explicitHints.includes('file') ||
    explicitHints.includes('config')
  ) {
    capabilities.add('file_write');
  }

  if (target.filePath?.trim()) {
    capabilities.add('file_write');
  }
  if (target.files?.some((f) => typeof f.path === 'string' && f.path.trim().length > 0)) {
    capabilities.add('file_write');
  }
  if (typeof target.suggestedFix === 'string' && SINGLE_LINE_FIX_PATTERN.test(target.suggestedFix)) {
    capabilities.add('file_write');
  }
  if (isPrLabelFix(target)) {
    capabilities.add('pr_label_write');
  }

  return capabilities;
}

function getAllowedPaths(target: FixTargetScope): Set<string> {
  const paths = new Set<string>();
  if (typeof target.filePath === 'string' && target.filePath.trim().length > 0) {
    paths.add(target.filePath.trim().toLowerCase());
  }
  if (Array.isArray(target.files)) {
    for (const file of target.files) {
      if (typeof file?.path === 'string' && file.path.trim().length > 0) {
        paths.add(file.path.trim().toLowerCase());
      }
    }
  }
  return paths;
}

function toolText(tool: ToolAuthorizationInput): string {
  return `${tool.name} ${tool.description}`.toLowerCase();
}

function isFileWriteTool(tool: ToolAuthorizationInput): boolean {
  const text = toolText(tool);
  if (
    text.includes('update_file') ||
    text.includes('commit_lifecycle_fix') ||
    text.includes('write_file') ||
    text.includes('edit_file') ||
    text.includes('modify_file')
  ) {
    return true;
  }
  return /\b(update|edit|modify|write|create|commit|patch|replace)\b/.test(text) && /\bfile\b/.test(text);
}

function isPrLabelWriteTool(tool: ToolAuthorizationInput): boolean {
  const text = toolText(tool);
  return (
    /\blabels?\b/.test(text) &&
    /\b(pr|pull[\s_-]?request|issue)\b/.test(text) &&
    /\b(add|set|remove|update|edit|patch|apply)\b/.test(text)
  );
}

function isK8sPatchTool(tool: ToolAuthorizationInput): boolean {
  const text = toolText(tool);
  if (text.includes('patch_k8s_resource')) return true;
  return /\b(k8s|kubernetes)\b/.test(text) && /\b(patch|apply|update|edit)\b/.test(text);
}

function isReadOnlyTool(tool: ToolAuthorizationInput): boolean {
  const text = toolText(tool);
  if (tool.safetyLevel === 'safe') return true;
  return (
    /\b(get|list|read|query|fetch|describe)\b/.test(text) &&
    !/\b(update|patch|write|create|delete|add|set|remove|apply|commit|edit)\b/.test(text)
  );
}

function getToolFilePath(args: Record<string, unknown>): string | undefined {
  const candidates = [args.file_path, args.path];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase();
    }
  }
  return undefined;
}

export function authorizeToolForFixTarget(
  target: FixTargetScope,
  tool: ToolAuthorizationInput
): ToolAuthorizationDecision {
  if (!target || typeof target !== 'object') {
    return { allowed: true };
  }

  if (isReadOnlyTool(tool)) {
    return { allowed: true };
  }

  const capabilities = detectCapabilities(target);
  const allowedPaths = getAllowedPaths(target);

  if (isFileWriteTool(tool)) {
    if (!capabilities.has('file_write')) {
      return {
        allowed: false,
        reason: `Blocked ${tool.name}: fix target "${
          target.serviceName || 'selected service'
        }" does not allow file edits`,
      };
    }
    if (allowedPaths.size > 0) {
      const requestedPath = getToolFilePath(tool.args);
      if (!requestedPath || !allowedPaths.has(requestedPath)) {
        return {
          allowed: false,
          reason: `Blocked ${tool.name}: file path is outside the selected fix target scope`,
        };
      }
    }
    return { allowed: true };
  }

  if (isPrLabelWriteTool(tool)) {
    if (!capabilities.has('pr_label_write')) {
      return {
        allowed: false,
        reason: `Blocked ${tool.name}: selected fix target does not allow PR label changes`,
      };
    }
    return { allowed: true };
  }

  if (isK8sPatchTool(tool)) {
    if (!capabilities.has('k8s_patch')) {
      return {
        allowed: false,
        reason: `Blocked ${tool.name}: selected fix target does not allow Kubernetes patching`,
      };
    }
    return { allowed: true };
  }

  if (tool.safetyLevel === 'dangerous' || tool.safetyLevel === 'cautious') {
    return {
      allowed: false,
      reason: `Blocked ${tool.name}: mutating tool is outside the selected fix target scope`,
    };
  }

  return { allowed: true };
}
