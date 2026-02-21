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

const mockCreatePvc = jest.fn();
const mockDeletePvc = jest.fn();

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        createNamespacedPersistentVolumeClaim: mockCreatePvc,
        deleteNamespacedPersistentVolumeClaim: mockDeletePvc,
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

import { createAgentPvc, deleteAgentPvc } from '../pvcFactory';

describe('pvcFactory', () => {
  const originalEnvironment = process.env.ENVIRONMENT;
  const originalAppEnv = process.env.APP_ENV;
  const originalAccessMode = process.env.AGENT_SESSION_PVC_ACCESS_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENVIRONMENT;
    delete process.env.APP_ENV;
    delete process.env.AGENT_SESSION_PVC_ACCESS_MODE;
  });

  afterAll(() => {
    process.env.ENVIRONMENT = originalEnvironment;
    process.env.APP_ENV = originalAppEnv;
    process.env.AGENT_SESSION_PVC_ACCESS_MODE = originalAccessMode;
  });

  describe('createAgentPvc', () => {
    it('creates a PVC with ReadWriteMany access mode', async () => {
      mockCreatePvc.mockResolvedValue({ body: { metadata: { name: 'test-pvc' } } });

      await createAgentPvc('test-ns', 'test-pvc', '10Gi');

      expect(mockCreatePvc).toHaveBeenCalledTimes(1);
      const [ns, pvcBody] = mockCreatePvc.mock.calls[0];
      expect(ns).toBe('test-ns');
      expect(pvcBody.metadata.name).toBe('test-pvc');
      expect(pvcBody.spec.accessModes).toEqual(['ReadWriteMany']);
      expect(pvcBody.spec.resources.requests.storage).toBe('10Gi');
    });

    it('uses default storage size when not provided', async () => {
      mockCreatePvc.mockResolvedValue({ body: { metadata: { name: 'test-pvc' } } });

      await createAgentPvc('test-ns', 'test-pvc');

      const [, pvcBody] = mockCreatePvc.mock.calls[0];
      expect(pvcBody.spec.resources.requests.storage).toBe('10Gi');
    });

    it('uses ReadWriteOnce in local dev environments', async () => {
      process.env.ENVIRONMENT = 'dev';
      mockCreatePvc.mockResolvedValue({ body: { metadata: { name: 'test-pvc' } } });

      await createAgentPvc('test-ns', 'test-pvc');

      const [, pvcBody] = mockCreatePvc.mock.calls[0];
      expect(pvcBody.spec.accessModes).toEqual(['ReadWriteOnce']);
    });

    it('honors AGENT_SESSION_PVC_ACCESS_MODE when configured', async () => {
      process.env.AGENT_SESSION_PVC_ACCESS_MODE = 'ReadWriteOnce';
      mockCreatePvc.mockResolvedValue({ body: { metadata: { name: 'test-pvc' } } });

      await createAgentPvc('test-ns', 'test-pvc');

      const [, pvcBody] = mockCreatePvc.mock.calls[0];
      expect(pvcBody.spec.accessModes).toEqual(['ReadWriteOnce']);
    });
  });

  describe('deleteAgentPvc', () => {
    it('deletes a PVC', async () => {
      mockDeletePvc.mockResolvedValue({});

      await deleteAgentPvc('test-ns', 'test-pvc');

      expect(mockDeletePvc).toHaveBeenCalledWith('test-pvc', 'test-ns');
    });

    it('ignores 404 errors', async () => {
      const error = new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404);
      mockDeletePvc.mockRejectedValue(error);

      await expect(deleteAgentPvc('test-ns', 'test-pvc')).resolves.toBeUndefined();
    });

    it('rethrows non-404 errors', async () => {
      mockDeletePvc.mockRejectedValue(new Error('server error'));

      await expect(deleteAgentPvc('test-ns', 'test-pvc')).rejects.toThrow('server error');
    });
  });
});
