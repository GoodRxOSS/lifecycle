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

import { getLogger } from 'server/lib/logger';

const VALID_STATUSES = new Set(['build_failed', 'deploy_failed', 'error', 'ready']);
const UNCERTAINTY_PATTERN = /\b(maybe|might|could|likely|possibly|uncertain|not sure|probably)\b/i;
const NON_ACTIONABLE_PATTERN = /\b(no action needed|manual fix|choose|decide|depends on)\b/i;
const SINGLE_LINE_FIX_PATTERN = /from ['"]([^'"]+)['"] to ['"]([^'"]+)['"] in ([\w/.+-]+\.\w+)/i;
const PR_LABEL_MUTATION_PATTERN = /\b(add|apply|set|remove|update|edit)\b/i;
const PR_LABEL_CONTEXT_PATTERN = /\b(pr|pull[\s-]?request)\b/i;
const LABEL_PATTERN = /\blabels?\b/i;

type AutoFixCapability = 'file_write' | 'pr_label_write' | 'k8s_patch';

export interface AvailableToolInfo {
  name: string;
  description?: string;
  category?: string;
  safetyLevel?: string;
}

export interface NormalizePayloadOptions {
  availableTools?: AvailableToolInfo[];
}

function hasSpecificErrorEvidence(service: Record<string, any>): boolean {
  const keyError = typeof service.keyError === 'string' ? service.keyError.trim() : '';
  const errorSource = typeof service.errorSource === 'string' ? service.errorSource.trim() : '';
  return keyError.length > 0 && errorSource.length > 0;
}

function hasFileDiffPayload(service: Record<string, any>): boolean {
  if (!Array.isArray(service.files)) return false;
  return service.files.some((file: Record<string, any>) => {
    if (!file || typeof file !== 'object') return false;
    const path = typeof file.path === 'string' ? file.path.trim() : '';
    return (
      path.length > 0 &&
      typeof file.oldContent === 'string' &&
      typeof file.newContent === 'string' &&
      file.oldContent !== file.newContent
    );
  });
}

function extractSingleLineFixFilePath(service: Record<string, any>): string | undefined {
  const explicitPath = typeof service.filePath === 'string' ? service.filePath.trim() : '';
  if (explicitPath.length > 0) return explicitPath;

  const suggestedFix = typeof service.suggestedFix === 'string' ? service.suggestedFix : '';
  const match = suggestedFix.match(SINGLE_LINE_FIX_PATTERN);
  if (!match || typeof match[3] !== 'string') return undefined;
  const derivedPath = match[3].trim();
  return derivedPath.length > 0 ? derivedPath : undefined;
}

function hasSingleLineFileTarget(service: Record<string, any>): boolean {
  const suggestedFix = typeof service.suggestedFix === 'string' ? service.suggestedFix : '';
  return Boolean(extractSingleLineFixFilePath(service)) && SINGLE_LINE_FIX_PATTERN.test(suggestedFix);
}

function isPrLabelFix(service: Record<string, any>): boolean {
  const suggestedFix = typeof service.suggestedFix === 'string' ? service.suggestedFix : '';
  return (
    suggestedFix.length > 0 &&
    PR_LABEL_MUTATION_PATTERN.test(suggestedFix) &&
    LABEL_PATTERN.test(suggestedFix) &&
    PR_LABEL_CONTEXT_PATTERN.test(suggestedFix)
  );
}

function isConfidentlyActionable(service: Record<string, any>): boolean {
  const issue = typeof service.issue === 'string' ? service.issue : '';
  const suggestedFix = typeof service.suggestedFix === 'string' ? service.suggestedFix : '';
  return (
    !UNCERTAINTY_PATTERN.test(issue) &&
    !UNCERTAINTY_PATTERN.test(suggestedFix) &&
    !NON_ACTIONABLE_PATTERN.test(suggestedFix)
  );
}

function toolText(tool: AvailableToolInfo): string {
  return `${tool.name || ''} ${tool.description || ''}`.toLowerCase();
}

function supportsFileWrite(tool: AvailableToolInfo): boolean {
  const text = toolText(tool);
  if (
    text.includes('update_file') ||
    text.includes('commit_lifecycle_fix') ||
    text.includes('edit_file') ||
    text.includes('write_file') ||
    text.includes('modify_file')
  ) {
    return true;
  }
  const hasMutation = /\b(update|edit|modify|write|create|commit|patch|replace)\b/.test(text);
  const hasFileScope = /\b(file|yaml|yml|config|manifest|dockerfile|helm|values)\b/.test(text);
  return hasMutation && hasFileScope;
}

function supportsPrLabelWrite(tool: AvailableToolInfo): boolean {
  const text = toolText(tool);
  const hasLabel = /\blabels?\b/.test(text);
  const hasPrContext = /\b(pr|pull[\s_-]?request|issue)\b/.test(text);
  const hasMutation = /\b(add|set|remove|update|edit|patch|apply)\b/.test(text);
  return hasLabel && hasPrContext && hasMutation;
}

function supportsK8sPatch(tool: AvailableToolInfo): boolean {
  const text = toolText(tool);
  if (text.includes('patch_k8s_resource')) return true;
  const hasK8s = /\b(k8s|kubernetes)\b/.test(text);
  const hasMutation = /\b(patch|apply|update|edit)\b/.test(text);
  const hasResource = /\b(resource|deployment|statefulset|service|configmap|secret|ingress)\b/.test(text);
  return hasK8s && hasMutation && hasResource;
}

function hasCapability(capability: AutoFixCapability, availableTools: AvailableToolInfo[]): boolean {
  if (capability === 'file_write') {
    return availableTools.some((tool) => supportsFileWrite(tool));
  }
  if (capability === 'pr_label_write') {
    return availableTools.some((tool) => supportsPrLabelWrite(tool));
  }
  return availableTools.some((tool) => supportsK8sPatch(tool));
}

function getRequiredCapabilities(service: Record<string, any>): AutoFixCapability[] {
  const explicitHintCandidates = ['autoFixAction', 'actionType', 'fixType', 'tool', 'toolName'];
  const explicitHint = explicitHintCandidates
    .map((key) => service[key])
    .find((value) => typeof value === 'string' && value.trim().length > 0)
    ?.toLowerCase();

  if (explicitHint) {
    if (
      explicitHint.includes('label') &&
      (explicitHint.includes('pr') || explicitHint.includes('pull') || explicitHint.includes('issue'))
    ) {
      return ['pr_label_write'];
    }
    if (
      explicitHint.includes('patch_k8s') ||
      (explicitHint.includes('k8s') && explicitHint.includes('patch')) ||
      (explicitHint.includes('kubernetes') && explicitHint.includes('patch'))
    ) {
      return ['k8s_patch'];
    }
    if (
      explicitHint.includes('update_file') ||
      explicitHint.includes('commit_lifecycle_fix') ||
      explicitHint.includes('file') ||
      explicitHint.includes('config')
    ) {
      return ['file_write'];
    }
  }

  const capabilities: AutoFixCapability[] = [];
  if (hasFileDiffPayload(service) || hasSingleLineFileTarget(service)) {
    capabilities.push('file_write');
  }
  if (isPrLabelFix(service)) {
    capabilities.push('pr_label_write');
  }
  return [...new Set(capabilities)];
}

function shouldAllowAutoFix(service: Record<string, any>, options: NormalizePayloadOptions): boolean {
  if (service.canAutoFix !== true) return false;
  if (!hasSpecificErrorEvidence(service)) return false;
  if (!isConfidentlyActionable(service)) return false;

  const requiredCapabilities = getRequiredCapabilities(service);
  if (requiredCapabilities.length === 0) return false;

  const availableTools = options.availableTools;
  if (!availableTools || availableTools.length === 0) {
    // Preserve legacy behavior when tool inventory is unavailable.
    return requiredCapabilities.every((capability) => capability === 'file_write');
  }

  return requiredCapabilities.every((capability) => hasCapability(capability, availableTools));
}

export function normalizeInvestigationPayload(parsed: any, options: NormalizePayloadOptions = {}): object {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }

  if (parsed.summary === undefined || parsed.summary === null) {
    parsed.summary = '';
  }

  if (!Array.isArray(parsed.services)) {
    parsed.services = [];
  }

  for (const service of parsed.services) {
    if (typeof service !== 'object' || service === null) continue;

    if (!service.serviceName) {
      service.serviceName = 'unknown';
    }

    if (!service.status) {
      service.status = 'error';
    } else if (!VALID_STATUSES.has(service.status)) {
      getLogger().warn(`AI: invalid service status="${service.status}" serviceName=${service.serviceName}`);
    }

    if (!service.issue) {
      service.issue = '';
    }

    if (!service.suggestedFix) {
      service.suggestedFix = '';
    }

    if (!service.filePath) {
      const derivedPath = extractSingleLineFixFilePath(service);
      if (derivedPath) {
        service.filePath = derivedPath;
      }
    }

    service.canAutoFix = shouldAllowAutoFix(service, options);

    if (typeof service.fixesApplied !== 'boolean') {
      service.fixesApplied = false;
    }
  }

  if (typeof parsed.fixesApplied !== 'boolean') {
    parsed.fixesApplied = false;
  }

  return parsed;
}
