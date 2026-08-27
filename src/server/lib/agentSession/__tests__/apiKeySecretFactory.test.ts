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

const mockCreateSecret = jest.fn();
const mockDeleteSecret = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        createNamespacedSecret: mockCreateSecret,
        deleteNamespacedSecret: mockDeleteSecret,
      }),
    })),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  }),
}));

import * as k8s from '@kubernetes/client-node';
import { createAgentApiKeySecret, deleteAgentApiKeySecret } from '../apiKeySecretFactory';

describe('apiKeySecretFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateSecret.mockResolvedValue({ body: { metadata: { name: 'agent-secret-abc123' } } });
    mockDeleteSecret.mockResolvedValue(undefined);
  });

  it('stores the GitHub token once in the session secret when provided', async () => {
    const result = await createAgentApiKeySecret(
      'test-ns',
      'agent-secret-abc123',
      {
        ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
        OPENAI_API_KEY: 'sample-openai-provider-key',
      },
      'sample-github-token'
    );

    expect(result).toEqual({ metadata: { name: 'agent-secret-abc123' } });
    expect(mockCreateSecret).toHaveBeenCalledWith(
      'test-ns',
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'agent-secret-abc123',
          namespace: 'test-ns',
        }),
        stringData: {
          ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
          OPENAI_API_KEY: 'sample-openai-provider-key',
          GITHUB_TOKEN: 'sample-github-token',
        },
      })
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'AgentRuntime: credentials prepared kind=api_key_secret secretName=agent-secret-abc123 namespace=test-ns'
    );
  });

  it('stores forwarded plain env values in the session secret', async () => {
    await createAgentApiKeySecret(
      'test-ns',
      'agent-secret-abc123',
      {
        ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
      },
      null,
      undefined,
      {
        PRIVATE_REGISTRY_TOKEN: 'plain-token',
      }
    );

    expect(mockCreateSecret).toHaveBeenCalledWith(
      'test-ns',
      expect.objectContaining({
        stringData: {
          ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
          PRIVATE_REGISTRY_TOKEN: 'plain-token',
        },
      })
    );
  });

  it('stores additional session-pod MCP config data in the session secret', async () => {
    await createAgentApiKeySecret('test-ns', 'agent-secret-abc123', undefined, undefined, undefined, undefined, {
      LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[{"slug":"figma"}]',
    });

    expect(mockCreateSecret).toHaveBeenCalledWith(
      'test-ns',
      expect.objectContaining({
        stringData: {
          LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[{"slug":"figma"}]',
        },
      })
    );
  });

  it('omits provider keys and GitHub token keys when no values are provided', async () => {
    await createAgentApiKeySecret('test-ns', 'agent-secret-abc123');

    expect(mockCreateSecret).toHaveBeenCalledWith(
      'test-ns',
      expect.objectContaining({
        stringData: {},
      })
    );
  });

  it('propagates Kubernetes creation failures without logging successful preparation', async () => {
    const error = new Error('Kubernetes API unavailable');
    mockCreateSecret.mockRejectedValue(error);

    await expect(createAgentApiKeySecret('test-ns', 'agent-secret-abc123')).rejects.toBe(error);

    expect(mockLoggerInfo).not.toHaveBeenCalled();
    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });

  describe('deleteAgentApiKeySecret', () => {
    it('deletes the named secret and logs successful cleanup', async () => {
      await expect(deleteAgentApiKeySecret('test-ns', 'agent-secret-abc123')).resolves.toBeUndefined();

      expect(mockDeleteSecret).toHaveBeenCalledWith('agent-secret-abc123', 'test-ns');
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'AgentRuntime: credentials cleaned kind=api_key_secret secretName=agent-secret-abc123 namespace=test-ns'
      );
    });

    it('treats a Kubernetes 404 as idempotent cleanup', async () => {
      const notFound = new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404);
      mockDeleteSecret.mockRejectedValue(notFound);

      await expect(deleteAgentApiKeySecret('test-ns', 'missing-secret')).resolves.toBeUndefined();

      expect(mockDeleteSecret).toHaveBeenCalledWith('missing-secret', 'test-ns');
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'AgentRuntime: credentials cleanup skipped reason=not_found kind=api_key_secret secretName=missing-secret namespace=test-ns'
      );
    });

    it('propagates non-404 Kubernetes failures without logging cleanup', async () => {
      const forbidden = new k8s.HttpError({ statusCode: 403 } as any, 'forbidden', 403);
      mockDeleteSecret.mockRejectedValue(forbidden);

      await expect(deleteAgentApiKeySecret('test-ns', 'agent-secret-abc123')).rejects.toBe(forbidden);

      expect(mockDeleteSecret).toHaveBeenCalledWith('agent-secret-abc123', 'test-ns');
      expect(mockLoggerInfo).not.toHaveBeenCalled();
    });

    it('propagates non-HTTP client failures without logging cleanup', async () => {
      const error = new Error('connection reset');
      mockDeleteSecret.mockRejectedValue(error);

      await expect(deleteAgentApiKeySecret('test-ns', 'agent-secret-abc123')).rejects.toBe(error);

      expect(mockDeleteSecret).toHaveBeenCalledWith('agent-secret-abc123', 'test-ns');
      expect(mockLoggerInfo).not.toHaveBeenCalled();
    });
  });
});
