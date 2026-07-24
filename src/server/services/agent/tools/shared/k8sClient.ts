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

export class K8sClient {
  public readonly kc: k8s.KubeConfig;
  public readonly coreApi: k8s.CoreV1Api;
  public readonly appsApi: k8s.AppsV1Api;
  public readonly batchApi: k8s.BatchV1Api;
  public readonly networkingApi: k8s.NetworkingV1Api;

  // SECURITY: the build's own namespace; tools reject any non-matching model-supplied namespace to prevent cross-tenant access.
  private allowedNamespace: string | null = null;

  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
  }

  setAllowedNamespace(namespace: string | null | undefined): void {
    this.allowedNamespace = namespace?.trim() || null;
  }

  getAllowedNamespace(): string | null {
    return this.allowedNamespace;
  }

  /** Resolve the namespace under build scope: defaults to the scope when omitted, rejects any mismatch; used as-is when no scope is set. */
  resolveNamespace(requested: string | null | undefined): string {
    const allowed = this.allowedNamespace;
    const requestedTrimmed = requested?.trim() || null;

    if (!allowed) {
      if (!requestedTrimmed) {
        throw new Error('namespace is required');
      }
      return requestedTrimmed;
    }

    if (!requestedTrimmed) {
      return allowed;
    }

    if (requestedTrimmed !== allowed) {
      throw new Error(
        `namespace "${requestedTrimmed}" is outside this environment's namespace "${allowed}" and cannot be accessed.`
      );
    }

    return allowed;
  }
}
