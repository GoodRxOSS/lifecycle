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

    if (typeof service.fixesApplied !== 'boolean') {
      service.fixesApplied = false;
    }
  }

  if (typeof parsed.fixesApplied !== 'boolean') {
    parsed.fixesApplied = false;
  }

  return parsed;
}
