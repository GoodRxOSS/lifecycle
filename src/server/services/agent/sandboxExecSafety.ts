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

const READ_ONLY_SEGMENT_PATTERNS: RegExp[] = [
  /^ls(?:\s|$)/,
  /^pwd(?:\s|$)/,
  /^find(?:\s|$)/,
  /^cat(?:\s|$)/,
  /^head(?:\s|$)/,
  /^tail(?:\s|$)/,
  /^stat(?:\s|$)/,
  /^which(?:\s|$)/,
  /^realpath(?:\s|$)/,
  /^basename(?:\s|$)/,
  /^dirname(?:\s|$)/,
  /^file(?:\s|$)/,
  /^wc(?:\s|$)/,
  /^sort(?:\s|$)/,
  /^uniq(?:\s|$)/,
  /^cut(?:\s|$)/,
  /^tr(?:\s|$)/,
  /^sed\s+-n(?:\s|$)/,
  /^awk(?:\s|$)/,
  /^rg(?:\s|$)/,
  /^grep(?:\s|$)/,
  /^git\s+status(?:\s|$)/,
  /^git\s+diff(?:\s|$)/,
  /^git\s+log(?:\s|$)/,
  /^git\s+show(?:\s|$)/,
  /^git\s+branch\s+--list(?:\s|$)/,
  /^git\s+remote(?:\s|$)/,
  /^git\s+rev-parse(?:\s|$)/,
  /^git\s+ls-files(?:\s|$)/,
  /^git\s+blame(?:\s|$)/,
];

const BLOCKED_SHELL_OPERATORS = /&&|\|\||;|`|\$\(/;
const DEV_NULL_REDIRECTION = /\s+\d?>\s*\/dev\/null/g;

function normalizeCommandSegment(segment: string): string {
  return segment.replace(DEV_NULL_REDIRECTION, '').trim();
}

function isReadOnlyCommandSegment(segment: string): boolean {
  const normalized = normalizeCommandSegment(segment);
  if (!normalized) {
    return false;
  }

  return READ_ONLY_SEGMENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isReadOnlyWorkspaceCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }

  if (BLOCKED_SHELL_OPERATORS.test(normalized)) {
    return false;
  }

  const segments = normalized
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return false;
  }

  return segments.every(isReadOnlyCommandSegment);
}
