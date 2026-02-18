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
const SINGLE_LINE_FIX_PATTERN = /from '([^']+)' to '([^']+)' in ([\w/.+-]+\.\w+)/;

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

function hasSingleLineFileTarget(service: Record<string, any>): boolean {
  const filePath = typeof service.filePath === 'string' ? service.filePath.trim() : '';
  const suggestedFix = typeof service.suggestedFix === 'string' ? service.suggestedFix : '';
  return filePath.length > 0 && SINGLE_LINE_FIX_PATTERN.test(suggestedFix);
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

function shouldAllowAutoFix(service: Record<string, any>): boolean {
  if (service.canAutoFix !== true) return false;
  if (!hasSpecificErrorEvidence(service)) return false;
  if (!isConfidentlyActionable(service)) return false;
  return hasFileDiffPayload(service) || hasSingleLineFileTarget(service);
}

export function normalizeInvestigationPayload(parsed: any): object {
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

    service.canAutoFix = shouldAllowAutoFix(service);

    if (typeof service.fixesApplied !== 'boolean') {
      service.fixesApplied = false;
    }
  }

  if (typeof parsed.fixesApplied !== 'boolean') {
    parsed.fixesApplied = false;
  }

  return parsed;
}
