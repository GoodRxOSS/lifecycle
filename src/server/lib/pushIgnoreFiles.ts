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
// A dependency closure in a monorepo can list many package directories.
const MAX_INCLUDE_PATTERNS = 200;
const MAX_IGNORE_PATTERN_LENGTH = 200;
const LIFECYCLE_CONFIG_FILE_PATHS = new Set(['lifecycle.yaml', 'lifecycle.yml', '.lifecycle.yaml', '.lifecycle.yml']);

export interface PushIgnoreServicePolicy {
  serviceName: string;
  ignoreFiles: string[];
  /** When set, any changed file outside these patterns is ignored for this service. */
  includeFiles?: string[];
}

export interface PushIgnoreDecision {
  shouldSkip: boolean;
  reason: string;
  serviceName?: string;
  filePath?: string;
  /** Services whose own policy ignores every changed file, when the others still deploy. */
  skipServices?: string[];
}

export function normalizeGithubPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function validatePattern(rawPattern: unknown, field: string): string {
  if (typeof rawPattern !== 'string') {
    throw new Error(`${field} patterns must be strings`);
  }

  const pattern = rawPattern.trim().replace(/\\/g, '/');
  if (!pattern) {
    throw new Error(`${field} patterns cannot be empty`);
  }

  if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) {
    throw new Error(`${field} pattern exceeds maximum length of ${MAX_IGNORE_PATTERN_LENGTH}: "${pattern}"`);
  }

  if (pattern.startsWith('/')) {
    throw new Error(`${field} patterns must be repo-relative: "${pattern}"`);
  }

  if (pattern.split('/').some((segment) => segment === '..')) {
    throw new Error(`${field} patterns cannot traverse directories: "${pattern}"`);
  }

  return pattern.replace(/^\.\//, '');
}

function normalizePatterns(rawPatterns: unknown, field: string, maxPatterns: number): string[] {
  if (rawPatterns == null) {
    return [];
  }

  if (!Array.isArray(rawPatterns)) {
    throw new Error(`${field} must be an array of strings`);
  }

  if (rawPatterns.length > maxPatterns) {
    throw new Error(`${field} has too many patterns: ${rawPatterns.length} exceeds ${maxPatterns}`);
  }

  return Array.from(new Set(rawPatterns.map((pattern) => validatePattern(pattern, field))));
}

export function normalizeIgnoreFiles(rawPatterns: unknown): string[] {
  return normalizePatterns(rawPatterns, 'ignoreFiles', MAX_IGNORE_PATTERNS);
}

export function normalizeIncludeFiles(rawPatterns: unknown): string[] {
  return normalizePatterns(rawPatterns, 'includeFiles', MAX_INCLUDE_PATTERNS);
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
  const includeFiles = normalizeIncludeFiles(service.includeFiles);
  if (ignoreFiles.length === 0 && includeFiles.length === 0) {
    return null;
  }

  return {
    serviceName,
    ignoreFiles,
    ...(includeFiles.length > 0 ? { includeFiles } : {}),
  };
}

function compileIgnoreMatcher(servicePolicy: PushIgnoreServicePolicy): (filePath: string) => boolean {
  const isIgnored = servicePolicy.ignoreFiles.length > 0 ? picomatch(servicePolicy.ignoreFiles, { dot: true }) : null;
  const isIncluded = servicePolicy.includeFiles?.length ? picomatch(servicePolicy.includeFiles, { dot: true }) : null;
  return (filePath) => (isIgnored?.(filePath) ?? false) || (isIncluded != null && !isIncluded(filePath));
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

  let deployDecision: PushIgnoreDecision | null = null;
  const skipServices: string[] = [];
  for (const servicePolicy of servicePolicies) {
    const { serviceName } = servicePolicy;
    if (servicePolicy.ignoreFiles.length === 0 && !servicePolicy.includeFiles?.length) {
      deployDecision ??= { shouldSkip: false, reason: 'missing_service_policy', serviceName };
      continue;
    }

    const isIgnored = compileIgnoreMatcher(servicePolicy);
    const filePath = normalizedChangedFiles.find((changedFile) => !isIgnored(changedFile));
    if (filePath) {
      deployDecision ??= { shouldSkip: false, reason: 'file_not_ignored', serviceName, filePath };
    } else {
      skipServices.push(serviceName);
    }
  }

  if (!deployDecision) {
    return { shouldSkip: true, reason: 'all_changed_files_ignored' };
  }

  return skipServices.length > 0 ? { ...deployDecision, skipServices } : deployDecision;
}
