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

import * as k8s from '@kubernetes/client-node';
import { BadRequestError, ConflictError, NotFoundError } from 'server/lib/appError';

import OpenSandboxPoolAdminService, { parseOpenSandboxPoolCapacityPatch } from '../OpenSandboxPoolAdminService';

function httpError(statusCode: number, body = 'k8s error') {
  return new k8s.HttpError({ statusCode } as any, body, statusCode);
}

function buildPool(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      name: 'lifecycle-workspace-pool',
      namespace: 'opensandbox',
      labels: {
        'app.kubernetes.io/part-of': 'lifecycle',
      },
      generation: 2,
      resourceVersion: 'rv-1',
      creationTimestamp: '2026-06-06T00:00:00Z',
    },
    spec: {
      capacitySpec: {
        poolMin: 1,
        poolMax: 3,
        bufferMin: 1,
        bufferMax: 1,
      },
      template: {
        spec: {
          containers: [
            {
              image: 'lifecycle-workspace:latest',
            },
          ],
        },
      },
    },
    status: {
      total: 3,
      allocated: 2,
      available: 1,
      observedGeneration: 2,
      revision: 'rev-1',
    },
    ...overrides,
  };
}

function buildService(apiOverrides: Record<string, unknown> = {}) {
  const customObjectsApi = {
    listNamespacedCustomObject: jest.fn().mockResolvedValue({
      body: {
        items: [buildPool()],
      },
    }),
    getNamespacedCustomObject: jest.fn().mockResolvedValue({
      body: buildPool(),
    }),
    patchNamespacedCustomObject: jest.fn().mockImplementation((_group, _version, _namespace, _plural, _name, body) =>
      Promise.resolve({
        body: buildPool({
          spec: {
            capacitySpec: (body as { spec: { capacitySpec: unknown } }).spec.capacitySpec,
            template: buildPool().spec.template,
          },
        }),
      })
    ),
    ...apiOverrides,
  };

  return {
    service: new OpenSandboxPoolAdminService(customObjectsApi as any),
    customObjectsApi,
  };
}

describe('OpenSandboxPoolAdminService', () => {
  it('lists OpenSandbox pools from the configured namespace', async () => {
    const { service, customObjectsApi } = buildService();

    const pools = await service.listPools('opensandbox');

    expect(customObjectsApi.listNamespacedCustomObject).toHaveBeenCalledWith(
      'sandbox.opensandbox.io',
      'v1alpha1',
      'opensandbox',
      'pools'
    );
    expect(pools).toEqual([
      {
        name: 'lifecycle-workspace-pool',
        namespace: 'opensandbox',
        capacitySpec: {
          poolMin: 1,
          poolMax: 3,
          bufferMin: 1,
          bufferMax: 1,
        },
        status: {
          total: 3,
          allocated: 2,
          available: 1,
          observedGeneration: 2,
          revision: 'rev-1',
        },
        image: 'lifecycle-workspace:latest',
        labels: {
          'app.kubernetes.io/part-of': 'lifecycle',
        },
        generation: 2,
        resourceVersion: 'rv-1',
        createdAt: '2026-06-06T00:00:00Z',
      },
    ]);
  });

  it('patches capacity with a merge patch after validating merged values', async () => {
    const { service, customObjectsApi } = buildService();

    const pool = await service.updateCapacity('opensandbox', 'lifecycle-workspace-pool', {
      poolMax: 4,
      bufferMax: 2,
    });

    expect(customObjectsApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      'sandbox.opensandbox.io',
      'v1alpha1',
      'opensandbox',
      'pools',
      'lifecycle-workspace-pool',
      {
        metadata: { resourceVersion: 'rv-1' },
        spec: {
          capacitySpec: {
            poolMin: 1,
            poolMax: 4,
            bufferMin: 1,
            bufferMax: 2,
          },
        },
      },
      undefined,
      'lifecycle-admin',
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    expect(pool.capacitySpec.poolMax).toBe(4);
    expect(pool.capacitySpec.bufferMax).toBe(2);
  });

  it('rejects invalid capacity relationships', async () => {
    const { service } = buildService();

    await expect(
      service.updateCapacity('opensandbox', 'lifecycle-workspace-pool', {
        poolMax: 1,
        bufferMax: 2,
      })
    ).rejects.toThrow('bufferMax must be less than or equal to poolMax.');
  });

  it('parses capacitySpec request bodies', () => {
    expect(
      parseOpenSandboxPoolCapacityPatch({
        capacitySpec: {
          poolMin: 2,
          poolMax: 4,
        },
      })
    ).toEqual({
      poolMin: 2,
      poolMax: 4,
    });
  });

  it('maps a k8s 404 from getPool to NotFoundError with opensandbox_pool_not_found', async () => {
    const { service } = buildService({
      getNamespacedCustomObject: jest.fn().mockRejectedValue(httpError(404, 'not found')),
    });

    const error = await service.getPool('opensandbox', 'missing-pool').catch((caught) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe('opensandbox_pool_not_found');
    expect(error.message).toContain('opensandbox/missing-pool');
  });

  it('rethrows non-404 errors from getPool', async () => {
    const failure = httpError(500, 'boom');
    const { service } = buildService({
      getNamespacedCustomObject: jest.fn().mockRejectedValue(failure),
    });

    await expect(service.getPool('opensandbox', 'lifecycle-workspace-pool')).rejects.toBe(failure);
  });

  it('returns an empty list when the pool CRD or namespace is missing', async () => {
    const { service } = buildService({
      listNamespacedCustomObject: jest.fn().mockRejectedValue(httpError(404, 'crd missing')),
    });

    await expect(service.listPools('opensandbox')).resolves.toEqual([]);
  });

  it('passes through non-404 errors from listPools', async () => {
    const failure = httpError(403, 'forbidden');
    const { service } = buildService({
      listNamespacedCustomObject: jest.fn().mockRejectedValue(failure),
    });

    await expect(service.listPools('opensandbox')).rejects.toBe(failure);
  });

  it('maps a k8s 409 on patch to ConflictError after pinning the read resourceVersion', async () => {
    const patchNamespacedCustomObject = jest.fn().mockRejectedValue(httpError(409, 'conflict'));
    const { service } = buildService({ patchNamespacedCustomObject });

    const error = await service
      .updateCapacity('opensandbox', 'lifecycle-workspace-pool', { poolMax: 5 })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('opensandbox_pool_conflict');
    expect(patchNamespacedCustomObject.mock.calls[0][5]).toMatchObject({
      metadata: { resourceVersion: 'rv-1' },
    });
  });

  it('rejects a patch whose merge with current capacity is invalid without calling k8s patch', async () => {
    const { service, customObjectsApi } = buildService();

    // Current poolMax is 3; merged bufferMax of 9 violates bufferMax <= poolMax.
    await expect(
      service.updateCapacity('opensandbox', 'lifecycle-workspace-pool', { bufferMax: 9 })
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(customObjectsApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('rejects an invalid namespace before calling k8s', async () => {
    const { service, customObjectsApi } = buildService();

    await expect(service.listPools('Bad_Namespace')).rejects.toBeInstanceOf(BadRequestError);
    expect(customObjectsApi.listNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('rejects an invalid pool name before calling k8s', async () => {
    const { service, customObjectsApi } = buildService();

    await expect(service.getPool('opensandbox', 'Bad_Name')).rejects.toBeInstanceOf(BadRequestError);
    expect(customObjectsApi.getNamespacedCustomObject).not.toHaveBeenCalled();
  });

  describe('parseOpenSandboxPoolCapacityPatch', () => {
    it('rejects non-object bodies', () => {
      expect(() => parseOpenSandboxPoolCapacityPatch(null)).toThrow('Request body must be an object.');
      expect(() => parseOpenSandboxPoolCapacityPatch('capacity')).toThrow('Request body must be an object.');
      expect(() => parseOpenSandboxPoolCapacityPatch([])).toThrow('Request body must be an object.');
    });

    it('rejects missing or non-object capacitySpec', () => {
      expect(() => parseOpenSandboxPoolCapacityPatch({})).toThrow('capacitySpec must be an object.');
      expect(() => parseOpenSandboxPoolCapacityPatch({ capacitySpec: 3 })).toThrow('capacitySpec must be an object.');
      expect(() => parseOpenSandboxPoolCapacityPatch({ capacitySpec: [1] })).toThrow('capacitySpec must be an object.');
    });

    it('rejects an empty capacitySpec', () => {
      expect(() => parseOpenSandboxPoolCapacityPatch({ capacitySpec: {} })).toThrow(
        'At least one capacity field is required.'
      );
    });

    it('rejects negative and non-integer values', () => {
      expect(() => parseOpenSandboxPoolCapacityPatch({ capacitySpec: { poolMin: -1 } })).toThrow(
        'poolMin must be a non-negative integer.'
      );
      expect(() => parseOpenSandboxPoolCapacityPatch({ capacitySpec: { bufferMax: 1.5 } })).toThrow(
        'bufferMax must be a non-negative integer.'
      );
    });

    it('accepts a partial capacitySpec including zero values', () => {
      expect(parseOpenSandboxPoolCapacityPatch({ capacitySpec: { bufferMin: 0, bufferMax: 2 } })).toEqual({
        bufferMin: 0,
        bufferMax: 2,
      });
    });
  });
});
