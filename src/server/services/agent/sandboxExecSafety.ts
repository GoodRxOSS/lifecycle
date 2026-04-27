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
const OUTPUT_REDIRECTION = /(^|[^0-9])>>?\s*(?!&)|[0-9]>>?\s*(?!\/dev\/null)/;
const UNSAFE_WORKSPACE_MUTATION_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  {
    pattern: /\bkill\b[^\n]*\$\(\s*pidof\s+node\s*\)/i,
    reason:
      'This command targets every node process and can terminate the workspace gateway. Inspect the process list and stop only the specific app process instead.',
  },
  {
    pattern: /\bkill\b[^\n]*\$\(\s*pgrep(?:\s+-f)?[^\n]*\b(?:node|workspace-gateway)\b[^\n]*\)/i,
    reason:
      'This command targets generic node or workspace-gateway processes and can terminate the workspace gateway. Stop only the specific app process instead.',
  },
  {
    pattern: /\b(?:pidof|pgrep(?:\s+-f)?)\b[^\n]*\b(?:node|workspace-gateway)\b[^\n]*\bxargs\s+kill\b/i,
    reason:
      'This command kills PIDs discovered from generic node or workspace-gateway process searches and can terminate the workspace gateway.',
  },
  {
    pattern: /\bps\b[^\n]*\bgrep\s+(?:-w\s+)?(?:node|workspace-gateway)\b[^\n]*\bxargs\s+kill\b/i,
    reason:
      'This command kills PIDs discovered from generic node or workspace-gateway process searches and can terminate the workspace gateway.',
  },
  {
    pattern: /\bpkill\b[^\n]*\b(?:node|workspace-gateway)\b/i,
    reason: 'This command kills generic node or workspace-gateway processes and can terminate the workspace gateway.',
  },
  {
    pattern: /\bkillall\b[^\n]*\b(?:node|workspace-gateway)\b/i,
    reason: 'This command kills generic node or workspace-gateway processes and can terminate the workspace gateway.',
  },
  {
    pattern: /\bkill\b[^\n]*(?:\$\$|\$PPID|\$BASHPID|\b1\b)/,
    reason: 'This command targets the current shell, its parent, or PID 1 and can terminate the workspace gateway.',
  },
];

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

  if (OUTPUT_REDIRECTION.test(normalized.replace(DEV_NULL_REDIRECTION, ''))) {
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

export function getUnsafeWorkspaceMutationReason(command: string): string | null {
  const normalized = command.trim();
  if (!normalized) {
    return null;
  }

  for (const entry of UNSAFE_WORKSPACE_MUTATION_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return entry.reason;
    }
  }

  return null;
}

export function assertSafeWorkspaceMutationCommand(command: string): void {
  const reason = getUnsafeWorkspaceMutationReason(command);
  if (reason) {
    throw new Error(reason);
  }
}
