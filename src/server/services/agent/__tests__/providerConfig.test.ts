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

import { getProviderEnvVarCandidates, isValidEnvVarName } from '../providerConfig';

describe('providerConfig', () => {
  it('accepts valid environment variable names', () => {
    expect(isValidEnvVarName('ANTHROPIC_API_KEY')).toBe(true);
  });

  it('rejects inline secrets as environment variable names', () => {
    expect(isValidEnvVarName('sample-inline-provider-secret')).toBe(false);
  });

  it('falls back to provider defaults when the explicit env var is invalid', () => {
    expect(getProviderEnvVarCandidates('gemini', 'sample-inline-provider-secret')).toEqual([
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_API_KEY',
    ]);
  });

  it('uses the explicit env var when it is valid', () => {
    expect(getProviderEnvVarCandidates('anthropic', 'ANTHROPIC_API_KEY_CUSTOM')).toEqual(['ANTHROPIC_API_KEY_CUSTOM']);
  });
});
