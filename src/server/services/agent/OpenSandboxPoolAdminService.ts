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

const OPEN_SANDBOX_POOL_GROUP = 'sandbox.opensandbox.io';
const OPEN_SANDBOX_POOL_VERSION = 'v1alpha1';
const OPEN_SANDBOX_POOL_PLURAL = 'pools';
const DEFAULT_OPEN_SANDBOX_POOL_NAMESPACE = 'opensandbox';

export interface OpenSandboxPoolCapacitySpec {
  poolMin: number;
  poolMax: number;
  bufferMin: number;
  bufferMax: number;
}

export interface OpenSandboxPoolStatus {
  total: number;
  allocated: number;
  available: number;
  observedGeneration?: number;
  revision?: string;
}

export interface OpenSandboxPoolSummary {
  name: string;
  namespace: string;
  capacitySpec: OpenSandboxPoolCapacitySpec;
  status: OpenSandboxPoolStatus;
  image?: string;
  labels: Record<string, string>;
  generation?: number;
  resourceVersion?: string;
  createdAt?: string;
}

export type OpenSandboxPoolCapacityPatch = Partial<OpenSandboxPoolCapacitySpec>;

interface OpenSandboxPoolResource {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    generation?: number;
    resourceVersion?: string;
    creationTimestamp?: string;
  };
  spec?: {
    capacitySpec?: Partial<Record<keyof OpenSandboxPoolCapacitySpec, unknown>>;
    template?: {
      spec?: {
        containers?: Array<{
          image?: string;
        }>;
      };
    };
  };
  status?: Partial<Record<keyof OpenSandboxPoolStatus, unknown>>;
}

interface OpenSandboxPoolListResource {
  items?: OpenSandboxPoolResource[];
}

function normalizeNamespace(namespace?: string | null): string {
  const value =
    namespace?.trim() || process.env.OPEN_SANDBOX_POOL_NAMESPACE?.trim() || DEFAULT_OPEN_SANDBOX_POOL_NAMESPACE;
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
    throw new BadRequestError('OpenSandbox pool namespace must be a valid Kubernetes namespace.');
  }
  return value;
}

function normalizeName(name: string): string {
  const value = name.trim();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
    throw new BadRequestError('OpenSandbox pool name must be a valid Kubernetes resource name.');
  }
  return value;
}

function readNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function readCapacity(pool: OpenSandboxPoolResource): OpenSandboxPoolCapacitySpec {
  const capacity = pool.spec?.capacitySpec || {};
  return {
    poolMin: readNonNegativeInteger(capacity.poolMin),
    poolMax: readNonNegativeInteger(capacity.poolMax),
    bufferMin: readNonNegativeInteger(capacity.bufferMin),
    bufferMax: readNonNegativeInteger(capacity.bufferMax),
  };
}

function readStatus(pool: OpenSandboxPoolResource): OpenSandboxPoolStatus {
  const status = pool.status || {};
  return {
    total: readNonNegativeInteger(status.total),
    allocated: readNonNegativeInteger(status.allocated),
    available: readNonNegativeInteger(status.available),
    ...(typeof status.observedGeneration === 'number' && Number.isFinite(status.observedGeneration)
      ? { observedGeneration: Math.trunc(status.observedGeneration) }
      : {}),
    ...(typeof status.revision === 'string' ? { revision: status.revision } : {}),
  };
}

function toPoolSummary(pool: OpenSandboxPoolResource): OpenSandboxPoolSummary {
  const name = pool.metadata?.name || '';
  const namespace = pool.metadata?.namespace || '';
  return {
    name,
    namespace,
    capacitySpec: readCapacity(pool),
    status: readStatus(pool),
    ...(pool.spec?.template?.spec?.containers?.[0]?.image
      ? { image: pool.spec.template.spec.containers[0].image }
      : {}),
    labels: pool.metadata?.labels || {},
    ...(typeof pool.metadata?.generation === 'number' ? { generation: pool.metadata.generation } : {}),
    ...(pool.metadata?.resourceVersion ? { resourceVersion: pool.metadata.resourceVersion } : {}),
    ...(pool.metadata?.creationTimestamp ? { createdAt: pool.metadata.creationTimestamp } : {}),
  };
}

function isNotFoundError(error: unknown): error is k8s.HttpError {
  return error instanceof k8s.HttpError && error.response?.statusCode === 404;
}

function parseOptionalCapacityValue(value: unknown, field: keyof OpenSandboxPoolCapacitySpec): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new BadRequestError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function validateCapacity(capacity: OpenSandboxPoolCapacitySpec): void {
  if (capacity.poolMin > capacity.poolMax) {
    throw new BadRequestError('poolMin must be less than or equal to poolMax.');
  }
  if (capacity.bufferMin > capacity.bufferMax) {
    throw new BadRequestError('bufferMin must be less than or equal to bufferMax.');
  }
  if (capacity.bufferMax > capacity.poolMax) {
    throw new BadRequestError('bufferMax must be less than or equal to poolMax.');
  }
}

export function parseOpenSandboxPoolCapacityPatch(body: unknown): OpenSandboxPoolCapacityPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('Request body must be an object.');
  }

  const capacitySpec = (body as { capacitySpec?: unknown }).capacitySpec;
  if (!capacitySpec || typeof capacitySpec !== 'object' || Array.isArray(capacitySpec)) {
    throw new BadRequestError('capacitySpec must be an object.');
  }

  const source = capacitySpec as Record<string, unknown>;
  const patch: OpenSandboxPoolCapacityPatch = {};

  for (const field of ['poolMin', 'poolMax', 'bufferMin', 'bufferMax'] as const) {
    const value = parseOptionalCapacityValue(source[field], field);
    if (value !== undefined) {
      patch[field] = value;
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new BadRequestError('At least one capacity field is required.');
  }

  return patch;
}

export default class OpenSandboxPoolAdminService {
  private readonly customObjectsApi: k8s.CustomObjectsApi;

  constructor(customObjectsApi?: k8s.CustomObjectsApi) {
    if (customObjectsApi) {
      this.customObjectsApi = customObjectsApi;
      return;
    }

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async listPools(namespace?: string | null): Promise<OpenSandboxPoolSummary[]> {
    const resolvedNamespace = normalizeNamespace(namespace);
    try {
      const response = await this.customObjectsApi.listNamespacedCustomObject(
        OPEN_SANDBOX_POOL_GROUP,
        OPEN_SANDBOX_POOL_VERSION,
        resolvedNamespace,
        OPEN_SANDBOX_POOL_PLURAL
      );
      const body = response.body as OpenSandboxPoolListResource;
      return (body.items || []).map(toPoolSummary).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      // Pool CRD not installed or namespace missing: report "no pools" rather than a 500.
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  async getPool(namespace: string, name: string): Promise<OpenSandboxPoolSummary> {
    const resolvedNamespace = normalizeNamespace(namespace);
    const resolvedName = normalizeName(name);

    try {
      const response = await this.customObjectsApi.getNamespacedCustomObject(
        OPEN_SANDBOX_POOL_GROUP,
        OPEN_SANDBOX_POOL_VERSION,
        resolvedNamespace,
        OPEN_SANDBOX_POOL_PLURAL,
        resolvedName
      );
      return toPoolSummary(response.body as OpenSandboxPoolResource);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new NotFoundError(
          `OpenSandbox pool "${resolvedNamespace}/${resolvedName}" was not found.`,
          'opensandbox_pool_not_found'
        );
      }
      throw error;
    }
  }

  async updateCapacity(
    namespace: string,
    name: string,
    patch: OpenSandboxPoolCapacityPatch
  ): Promise<OpenSandboxPoolSummary> {
    const resolvedNamespace = normalizeNamespace(namespace);
    const resolvedName = normalizeName(name);
    const current = await this.getPool(resolvedNamespace, resolvedName);
    const nextCapacity: OpenSandboxPoolCapacitySpec = {
      ...current.capacitySpec,
      ...patch,
    };
    validateCapacity(nextCapacity);

    try {
      const response = await this.customObjectsApi.patchNamespacedCustomObject(
        OPEN_SANDBOX_POOL_GROUP,
        OPEN_SANDBOX_POOL_VERSION,
        resolvedNamespace,
        OPEN_SANDBOX_POOL_PLURAL,
        resolvedName,
        {
          // Pin the read revision so concurrent admin edits conflict instead of silently clobbering.
          ...(current.resourceVersion ? { metadata: { resourceVersion: current.resourceVersion } } : {}),
          spec: { capacitySpec: nextCapacity },
        },
        undefined,
        'lifecycle-admin',
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
      return toPoolSummary(response.body as OpenSandboxPoolResource);
    } catch (error) {
      if (error instanceof k8s.HttpError && error.response?.statusCode === 409) {
        throw new ConflictError(
          `OpenSandbox pool "${resolvedNamespace}/${resolvedName}" was modified concurrently; retry the update.`,
          'opensandbox_pool_conflict'
        );
      }
      throw error;
    }
  }
}
