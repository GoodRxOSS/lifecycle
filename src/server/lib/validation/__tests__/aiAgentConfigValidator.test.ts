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

import { validateAIAgentConfig, AIAgentConfigValidationError } from '../aiAgentConfigValidator';
import type { AIAgentConfig } from 'server/services/types/aiAgentConfig';

function makeConfig(): AIAgentConfig {
  return {
    enabled: true,
    providers: [
      {
        name: 'anthropic',
        enabled: true,
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        models: [
          {
            id: 'claude-sonnet-4-20250514',
            displayName: 'Claude Sonnet 4',
            enabled: true,
            default: true,
            maxTokens: 8192,
          },
        ],
      },
    ],
    maxMessagesPerSession: 50,
    sessionTTL: 3600,
  };
}

describe('validateAIAgentConfig', () => {
  it('accepts a valid config', () => {
    expect(() => validateAIAgentConfig(makeConfig())).not.toThrow();
  });

  it('rejects inline secrets in apiKeyEnvVar', () => {
    const config = makeConfig();
    config.providers[0].apiKeyEnvVar = 'sk-ant-secret-value';

    expect(() => validateAIAgentConfig(config)).toThrow(AIAgentConfigValidationError);
    expect(() => validateAIAgentConfig(config)).toThrow('apiKeyEnvVar must be an environment variable name');
  });

  it('rejects duplicate providers', () => {
    const config = makeConfig();
    config.providers.push({
      ...config.providers[0],
      name: 'Anthropic',
    });

    expect(() => validateAIAgentConfig(config)).toThrow('Duplicate provider "anthropic"');
  });

  it('rejects enabled providers with no enabled models', () => {
    const config = makeConfig();
    config.providers[0].models[0].enabled = false;
    config.providers[0].models[0].default = false;

    expect(() => validateAIAgentConfig(config)).toThrow('must have at least one enabled model');
  });
});
