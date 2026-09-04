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

import { validateFileExclusionPatterns } from '../filePatternValidator';

describe('validateFileExclusionPatterns', () => {
  it('accepts empty, scoped glob, count-boundary, and length-boundary inputs', () => {
    expect(() => validateFileExclusionPatterns([])).not.toThrow();
    expect(() => validateFileExclusionPatterns(['node_modules/**', 'dist/**/*', '*.log'])).not.toThrow();
    expect(() =>
      validateFileExclusionPatterns(Array.from({ length: 50 }, (_, index) => `file-${index}`))
    ).not.toThrow();
    expect(() => validateFileExclusionPatterns(['x'.repeat(200)])).not.toThrow();
  });

  it('rejects more than 50 patterns before inspecting individual entries', () => {
    const patterns = Array.from({ length: 51 }, (_, index) => `file-${index}`);

    expect(() => validateFileExclusionPatterns(patterns)).toThrow(
      'Too many file exclusion patterns: 51 exceeds maximum of 50'
    );
  });

  it('rejects a pattern over the 200-character boundary', () => {
    const pattern = 'x'.repeat(201);

    expect(() => validateFileExclusionPatterns([pattern])).toThrow(
      `File exclusion pattern exceeds maximum length of 200: "${pattern}"`
    );
  });

  it.each(['*', '**', '**/*', '  **/*  '])('rejects the overly broad pattern %p', (pattern) => {
    expect(() => validateFileExclusionPatterns([pattern])).toThrow(
      `Overly broad file exclusion pattern not allowed: "${pattern}"`
    );
  });

  it.each(['../secrets', 'config/../secrets'])('rejects traversal in %p', (pattern) => {
    expect(() => validateFileExclusionPatterns([pattern])).toThrow(
      `Path traversal not allowed in file exclusion pattern: "${pattern}"`
    );
  });

  it('rejects absolute paths', () => {
    expect(() => validateFileExclusionPatterns(['/var/run/secrets'])).toThrow(
      'Absolute paths not allowed in file exclusion pattern: "/var/run/secrets"'
    );
  });
});
