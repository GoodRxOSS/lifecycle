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

const getAllConfigs = jest.fn();

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs,
    })),
  },
}));

import {
  AgentSessionRuntimeConfigError,
  mergeAgentSessionReadiness,
  mergeAgentSessionReadinessForServices,
  mergeAgentSessionResources,
  renderAgentSessionClaudeAttribution,
  resolveAgentSessionClaudeConfig,
  resolveAgentSessionClaudeConfigFromDefaults,
  resolveAgentSessionReadinessFromDefaults,
  resolveAgentSessionResourcesFromDefaults,
  resolveAgentSessionRuntimeConfig,
} from '../runtimeConfig';

describe('runtimeConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the configured agent and editor images', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        image: 'lifecycle-agent:sha-123',
        editorImage: 'codercom/code-server:4.98.2',
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual({
      image: 'lifecycle-agent:sha-123',
      editorImage: 'codercom/code-server:4.98.2',
      readiness: {
        timeoutMs: 60000,
        pollMs: 2000,
      },
      resources: {
        agent: {
          requests: {
            cpu: '500m',
            memory: '1Gi',
          },
          limits: {
            cpu: '2',
            memory: '4Gi',
          },
        },
        editor: {
          requests: {
            cpu: '250m',
            memory: '512Mi',
          },
          limits: {
            cpu: '1',
            memory: '1Gi',
          },
        },
      },
      claude: {
        permissions: {
          allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
          deny: [],
        },
        attribution: {
          commitTemplate: 'Generated with ({appName})',
          prTemplate: 'Generated with ({appName})',
        },
      },
    });
  });

  it('returns the configured agent scheduling when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        image: 'lifecycle-agent:sha-123',
        editorImage: 'codercom/code-server:4.98.2',
        scheduling: {
          nodeSelector: {
            'app-long': 'deployments-m7i',
            pool: 'agents',
          },
        },
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual({
      image: 'lifecycle-agent:sha-123',
      editorImage: 'codercom/code-server:4.98.2',
      nodeSelector: {
        'app-long': 'deployments-m7i',
        pool: 'agents',
      },
      readiness: {
        timeoutMs: 60000,
        pollMs: 2000,
      },
      resources: {
        agent: {
          requests: {
            cpu: '500m',
            memory: '1Gi',
          },
          limits: {
            cpu: '2',
            memory: '4Gi',
          },
        },
        editor: {
          requests: {
            cpu: '250m',
            memory: '512Mi',
          },
          limits: {
            cpu: '1',
            memory: '1Gi',
          },
        },
      },
      claude: {
        permissions: {
          allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
          deny: [],
        },
        attribution: {
          commitTemplate: 'Generated with ({appName})',
          prTemplate: 'Generated with ({appName})',
        },
      },
    });
  });

  it('returns configured agent and editor resources when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        image: 'lifecycle-agent:sha-123',
        editorImage: 'codercom/code-server:4.98.2',
        resources: {
          agent: {
            requests: {
              cpu: '900m',
            },
            limits: {
              memory: '6Gi',
            },
          },
          editor: {
            requests: {
              memory: '768Mi',
            },
            limits: {
              cpu: '1500m',
            },
          },
        },
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual({
      image: 'lifecycle-agent:sha-123',
      editorImage: 'codercom/code-server:4.98.2',
      readiness: {
        timeoutMs: 60000,
        pollMs: 2000,
      },
      resources: {
        agent: {
          requests: {
            cpu: '900m',
            memory: '1Gi',
          },
          limits: {
            cpu: '2',
            memory: '6Gi',
          },
        },
        editor: {
          requests: {
            cpu: '250m',
            memory: '768Mi',
          },
          limits: {
            cpu: '1500m',
            memory: '1Gi',
          },
        },
      },
      claude: {
        permissions: {
          allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
          deny: [],
        },
        attribution: {
          commitTemplate: 'Generated with ({appName})',
          prTemplate: 'Generated with ({appName})',
        },
      },
    });
  });

  it('returns configured readiness settings when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        image: 'lifecycle-agent:sha-123',
        editorImage: 'codercom/code-server:4.98.2',
        readiness: {
          timeoutMs: 120000,
          pollMs: 500,
        },
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).resolves.toEqual({
      image: 'lifecycle-agent:sha-123',
      editorImage: 'codercom/code-server:4.98.2',
      readiness: {
        timeoutMs: 120000,
        pollMs: 500,
      },
      resources: {
        agent: {
          requests: {
            cpu: '500m',
            memory: '1Gi',
          },
          limits: {
            cpu: '2',
            memory: '4Gi',
          },
        },
        editor: {
          requests: {
            cpu: '250m',
            memory: '512Mi',
          },
          limits: {
            cpu: '1',
            memory: '1Gi',
          },
        },
      },
      claude: {
        permissions: {
          allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
          deny: [],
        },
        attribution: {
          commitTemplate: 'Generated with ({appName})',
          prTemplate: 'Generated with ({appName})',
        },
      },
    });
  });

  it('returns the configured Claude settings when present', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        claude: {
          permissions: {
            allow: ['Read(*)'],
            deny: ['Bash(*)'],
          },
          attribution: {
            commitTemplate: 'Commit from ({appName})',
            prTemplate: 'PR from ({appName})',
          },
          appendSystemPrompt: 'Use concise responses.',
        },
      },
    });

    await expect(resolveAgentSessionClaudeConfig()).resolves.toEqual({
      permissions: {
        allow: ['Read(*)'],
        deny: ['Bash(*)'],
      },
      attribution: {
        commitTemplate: 'Commit from ({appName})',
        prTemplate: 'PR from ({appName})',
      },
      appendSystemPrompt: 'Use concise responses.',
    });
  });

  it('falls back to default Claude settings when config is empty', () => {
    expect(resolveAgentSessionClaudeConfigFromDefaults()).toEqual({
      permissions: {
        allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
        deny: [],
      },
      attribution: {
        commitTemplate: 'Generated with ({appName})',
        prTemplate: 'Generated with ({appName})',
      },
      appendSystemPrompt: undefined,
    });
  });

  it('merges lifecycle resource overrides over runtime defaults', () => {
    expect(
      mergeAgentSessionResources(resolveAgentSessionResourcesFromDefaults(), {
        agent: {
          requests: {
            cpu: '1200m',
          },
        },
        editor: {
          limits: {
            memory: '2Gi',
          },
        },
      })
    ).toEqual({
      agent: {
        requests: {
          cpu: '1200m',
          memory: '1Gi',
        },
        limits: {
          cpu: '2',
          memory: '4Gi',
        },
      },
      editor: {
        requests: {
          cpu: '250m',
          memory: '512Mi',
        },
        limits: {
          cpu: '1',
          memory: '2Gi',
        },
      },
    });
  });

  it('merges direct readiness overrides over runtime defaults', () => {
    expect(
      mergeAgentSessionReadiness(resolveAgentSessionReadinessFromDefaults({ timeoutMs: 60000, pollMs: 2000 }), {
        timeoutMs: 120000,
      })
    ).toEqual({
      timeoutMs: 120000,
      pollMs: 2000,
    });
  });

  it('merges service readiness overrides over runtime defaults', () => {
    expect(
      mergeAgentSessionReadinessForServices(
        resolveAgentSessionReadinessFromDefaults({ timeoutMs: 60000, pollMs: 2000 }),
        [{ timeoutMs: 120000 }, { timeoutMs: 90000, pollMs: 500 }, undefined, { pollMs: 1000 }]
      )
    ).toEqual({
      timeoutMs: 120000,
      pollMs: 500,
    });
  });

  it('renders attribution from the app name placeholder', () => {
    expect(renderAgentSessionClaudeAttribution('Generated with ({appName})', 'sample-app')).toBe(
      'Generated with (sample-app)'
    );
    expect(renderAgentSessionClaudeAttribution('Generated with ({appName})', null)).toBe('');
    expect(renderAgentSessionClaudeAttribution('Static attribution', 'sample-app')).toBe('Static attribution');
  });

  it('throws when the agent image is missing', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        image: null,
        editorImage: 'codercom/code-server:4.98.2',
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).rejects.toEqual(
      expect.objectContaining<Partial<AgentSessionRuntimeConfigError>>({
        name: 'AgentSessionRuntimeConfigError',
        missingFields: ['image'],
      })
    );
  });

  it('throws when the editor image is missing', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {
        image: 'lifecycle-agent:sha-123',
        editorImage: '  ',
      },
    });

    await expect(resolveAgentSessionRuntimeConfig()).rejects.toEqual(
      expect.objectContaining<Partial<AgentSessionRuntimeConfigError>>({
        name: 'AgentSessionRuntimeConfigError',
        missingFields: ['editorImage'],
      })
    );
  });

  it('throws when both runtime images are missing', async () => {
    getAllConfigs.mockResolvedValue({
      agentSessionDefaults: {},
    });

    await expect(resolveAgentSessionRuntimeConfig()).rejects.toEqual(
      expect.objectContaining<Partial<AgentSessionRuntimeConfigError>>({
        name: 'AgentSessionRuntimeConfigError',
        missingFields: ['image', 'editorImage'],
      })
    );
  });
});
