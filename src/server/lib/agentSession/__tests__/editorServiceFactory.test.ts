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

import * as k8s from '@kubernetes/client-node';

const mockCreateService = jest.fn();
const mockDeleteService = jest.fn();

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        createNamespacedService: mockCreateService,
        deleteNamespacedService: mockDeleteService,
      }),
    })),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { createAgentEditorService, deleteAgentEditorService } from '../editorServiceFactory';
import { AGENT_EDITOR_PORT } from '../podFactory';

describe('editorServiceFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a ClusterIP editor service for the session pod', async () => {
    mockCreateService.mockResolvedValue({ body: { metadata: { name: 'agent-abc123' } } });

    await createAgentEditorService('test-ns', 'agent-abc123');

    expect(mockCreateService).toHaveBeenCalledWith(
      'test-ns',
      expect.objectContaining({
        metadata: expect.objectContaining({ name: 'agent-abc123' }),
        spec: expect.objectContaining({
          selector: { 'app.kubernetes.io/name': 'agent-abc123' },
          ports: [{ name: 'editor', port: AGENT_EDITOR_PORT, targetPort: AGENT_EDITOR_PORT }],
        }),
      })
    );
  });

  it('deletes the editor service', async () => {
    mockDeleteService.mockResolvedValue({});

    await deleteAgentEditorService('test-ns', 'agent-abc123');

    expect(mockDeleteService).toHaveBeenCalledWith('agent-abc123', 'test-ns');
  });

  it('ignores 404 errors when deleting the editor service', async () => {
    const error = new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404);
    mockDeleteService.mockRejectedValue(error);

    await expect(deleteAgentEditorService('test-ns', 'agent-abc123')).resolves.toBeUndefined();
  });
});
