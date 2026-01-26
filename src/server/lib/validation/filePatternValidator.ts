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

const FORBIDDEN_PATTERNS = ['*', '**', '**/*'];
const MAX_PATTERNS = 50;
const MAX_PATTERN_LENGTH = 200;

export function validateFileExclusionPatterns(patterns: string[]): void {
  if (patterns.length > MAX_PATTERNS) {
    throw new Error(`Too many file exclusion patterns: ${patterns.length} exceeds maximum of ${MAX_PATTERNS}`);
  }

  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`File exclusion pattern exceeds maximum length of ${MAX_PATTERN_LENGTH}: "${pattern}"`);
    }
    if (FORBIDDEN_PATTERNS.includes(pattern.trim())) {
      throw new Error(`Overly broad file exclusion pattern not allowed: "${pattern}"`);
    }
    if (pattern.includes('../')) {
      throw new Error(`Path traversal not allowed in file exclusion pattern: "${pattern}"`);
    }
    if (pattern.startsWith('/')) {
      throw new Error(`Absolute paths not allowed in file exclusion pattern: "${pattern}"`);
    }
  }
}
