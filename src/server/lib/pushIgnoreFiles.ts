/**
 * Copyright 2026 GoodRx, Inc.
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

import picomatch from 'picomatch';
import type { LifecycleConfig } from 'server/models/yaml/Config';

const MAX_IGNORE_PATTERNS = 50;
const MAX_IGNORE_PATTERN_LENGTH = 200;
const LIFECYCLE_CONFIG_FILE_PATHS = new Set(['lifecycle.yaml', 'lifecycle.yml', '.lifecycle.yaml', '.lifecycle.yml']);

export interface PushIgnoreServicePolicy {
  serviceName: string;
  ignoreFiles: string[];
}

export interface PushIgnoreDecision {
  shouldSkip: boolean;
  reason: string;
  serviceName?: string;
  filePath?: string;
}

export function normalizeGithubPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function validateIgnorePattern(rawPattern: unknown): string {
  if (typeof rawPattern !== 'string') {
    throw new Error(`ignoreFiles patterns must be strings`);
  }

  const pattern = rawPattern.trim().replace(/\\/g, '/');
  if (!pattern) {
    throw new Error('ignoreFiles patterns cannot be empty');
  }

  if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) {
    throw new Error(`ignoreFiles pattern exceeds maximum length of ${MAX_IGNORE_PATTERN_LENGTH}: "${pattern}"`);
  }

  if (pattern.startsWith('/')) {
    throw new Error(`ignoreFiles patterns must be repo-relative: "${pattern}"`);
  }

  if (pattern.split('/').some((segment) => segment === '..')) {
    throw new Error(`ignoreFiles patterns cannot traverse directories: "${pattern}"`);
  }

  return pattern.replace(/^\.\//, '');
}

export function normalizeIgnoreFiles(rawPatterns: unknown): string[] {
  if (rawPatterns == null) {
    return [];
  }

  if (!Array.isArray(rawPatterns)) {
    throw new Error('ignoreFiles must be an array of strings');
  }

  if (rawPatterns.length > MAX_IGNORE_PATTERNS) {
    throw new Error(`ignoreFiles has too many patterns: ${rawPatterns.length} exceeds ${MAX_IGNORE_PATTERNS}`);
  }

  return Array.from(new Set(rawPatterns.map(validateIgnorePattern)));
}

export function getEffectiveIgnoreFiles(environmentIgnoreFiles: unknown, serviceIgnoreFiles: unknown): string[] {
  return Array.from(
    new Set([...normalizeIgnoreFiles(environmentIgnoreFiles), ...normalizeIgnoreFiles(serviceIgnoreFiles)])
  );
}

export function getServicePushIgnorePolicy(
  config: LifecycleConfig,
  serviceName: string
): PushIgnoreServicePolicy | null {
  const service = config?.services?.find((candidate) => candidate.name === serviceName);
  if (!service) {
    return null;
  }

  const ignoreFiles = getEffectiveIgnoreFiles(config.environment?.ignoreFiles, service.ignoreFiles);
  if (ignoreFiles.length === 0) {
    return null;
  }

  return {
    serviceName,
    ignoreFiles,
  };
}

export function hasLifecycleConfigChange(changedFiles: string[]): boolean {
  return changedFiles.some((filePath) => {
    const normalized = normalizeGithubPath(filePath);
    return LIFECYCLE_CONFIG_FILE_PATHS.has(normalized);
  });
}

export function shouldSkipPushDeploy({
  changedFiles,
  servicePolicies,
}: {
  changedFiles: string[];
  servicePolicies: PushIgnoreServicePolicy[];
}): PushIgnoreDecision {
  const normalizedChangedFiles = changedFiles.map(normalizeGithubPath).filter(Boolean);

  if (normalizedChangedFiles.length === 0) {
    return { shouldSkip: false, reason: 'no_changed_files' };
  }

  if (hasLifecycleConfigChange(normalizedChangedFiles)) {
    return { shouldSkip: false, reason: 'lifecycle_config_changed' };
  }

  if (servicePolicies.length === 0) {
    return { shouldSkip: false, reason: 'no_service_policies' };
  }

  for (const servicePolicy of servicePolicies) {
    if (servicePolicy.ignoreFiles.length === 0) {
      return { shouldSkip: false, reason: 'missing_service_policy', serviceName: servicePolicy.serviceName };
    }

    for (const filePath of normalizedChangedFiles) {
      if (!picomatch.isMatch(filePath, servicePolicy.ignoreFiles, { dot: true })) {
        return {
          shouldSkip: false,
          reason: 'file_not_ignored',
          serviceName: servicePolicy.serviceName,
          filePath,
        };
      }
    }
  }

  return { shouldSkip: true, reason: 'all_changed_files_ignored' };
}
