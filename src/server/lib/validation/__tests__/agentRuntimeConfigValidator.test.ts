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

import {
  validateAgentRuntimeConfig,
  validateAgentRuntimeRepoOverride,
  AgentRuntimeConfigValidationError,
} from '../agentRuntimeConfigValidator';
import type { AgentRuntimeConfig } from 'server/services/types/agentRuntimeConfig';

function makeConfig(): AgentRuntimeConfig {
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

describe('validateAgentRuntimeConfig', () => {
  it('accepts a valid config', () => {
    expect(() => validateAgentRuntimeConfig(makeConfig())).not.toThrow();
  });

  it('rejects inline secrets in apiKeyEnvVar', () => {
    const config = makeConfig();
    config.providers[0].apiKeyEnvVar = 'sk-ant-secret-value';

    expect(() => validateAgentRuntimeConfig(config)).toThrow(AgentRuntimeConfigValidationError);
    expect(() => validateAgentRuntimeConfig(config)).toThrow('apiKeyEnvVar must be an environment variable name');
  });

  it('rejects duplicate providers', () => {
    const config = makeConfig();
    config.providers.push({
      ...config.providers[0],
      name: 'Anthropic',
    });

    expect(() => validateAgentRuntimeConfig(config)).toThrow('Duplicate provider "anthropic"');
  });

  it('rejects enabled providers with no enabled models', () => {
    const config = makeConfig();
    config.providers[0].models[0].enabled = false;
    config.providers[0].models[0].default = false;

    expect(() => validateAgentRuntimeConfig(config)).toThrow('must have at least one enabled model');
  });

  it('accepts valid capability availability policy', () => {
    const config = makeConfig();
    config.capabilityPolicy = {
      availability: {
        workspace_shell: 'admin_only',
        diagnostics_database: 'disabled',
      },
    };

    expect(() => validateAgentRuntimeConfig(config)).not.toThrow();
  });

  it('rejects unknown capability ids', () => {
    const config = makeConfig();
    config.capabilityPolicy = {
      availability: {
        sample_unknown: 'disabled',
      } as any,
    };

    expect(() => validateAgentRuntimeConfig(config)).toThrow('Unknown capability id "sample_unknown".');
  });

  it('rejects invalid capability availability values', () => {
    const config = makeConfig();
    config.capabilityPolicy = {
      availability: {
        workspace_shell: 'sometimes',
      } as any,
    };

    expect(() => validateAgentRuntimeConfig(config)).toThrow(
      'Capability "workspace_shell" has invalid availability "sometimes".'
    );
  });

  it('validates capability policy in repo overrides', () => {
    expect(() =>
      validateAgentRuntimeRepoOverride({
        capabilityPolicy: {
          availability: {
            external_mcp_write: 'admin_only',
          },
        },
      })
    ).not.toThrow();
    expect(() =>
      validateAgentRuntimeRepoOverride({
        capabilityPolicy: {
          availability: {
            sample_unknown: 'disabled',
          } as any,
        },
      })
    ).toThrow('Unknown capability id "sample_unknown".');
  });

  it('accepts valid custom-agent creation policy', () => {
    const config = makeConfig();
    config.customAgentCreationPolicy = {
      mode: 'allowlist',
      allowedUserIds: ['sample-user'],
      allowedGithubUsernames: ['sample-gh-user'],
      capabilityAvailability: {
        external_mcp_write: 'reserved',
        read_context: 'available',
      },
    };

    expect(() => validateAgentRuntimeConfig(config)).not.toThrow();
  });

  it('rejects invalid custom-agent creation policy values', () => {
    const config = makeConfig();
    config.customAgentCreationPolicy = {
      mode: 'sometimes',
      allowedUserIds: ['sample-user'],
    } as any;

    expect(() => validateAgentRuntimeConfig(config)).toThrow('Invalid custom agent creation mode "sometimes".');

    config.customAgentCreationPolicy = {
      mode: 'enabled',
      allowedGithubUsernames: ['sample-user'],
      capabilityAvailability: {
        sample_unknown: 'reserved',
      },
    } as any;

    expect(() => validateAgentRuntimeConfig(config)).toThrow('Unknown creator capability id "sample_unknown".');

    config.customAgentCreationPolicy = {
      mode: 'enabled',
      capabilityAvailability: {
        read_context: 'maybe',
      },
    } as any;

    expect(() => validateAgentRuntimeConfig(config)).toThrow(
      'Creator capability "read_context" has invalid availability "maybe".'
    );
  });
});
