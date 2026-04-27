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
import { APP_HOST } from 'shared/config';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';
import { normalizeKubernetesLabelValue } from 'server/lib/kubernetes/utils';
import GlobalConfigService from 'server/services/globalConfig';

export interface ChatPreviewPublication {
  url: string;
  host: string | null;
  path: string;
  serviceName: string;
  ingressName: string;
  port: number;
}

function getClients() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  return {
    coreApi: kc.makeApiClient(k8s.CoreV1Api),
    networkingApi: kc.makeApiClient(k8s.NetworkingV1Api),
  };
}

function buildResourceName(prefix: string, sessionUuid: string, port: number): string {
  return normalizeKubernetesLabelValue(`${prefix}-${sessionUuid.slice(0, 8)}-${port}`).replace(/[_.]/g, '-');
}

function buildPreviewPath(sessionUuid: string, port: number): string {
  return `/_chat/${sessionUuid}/${port}`;
}

function resolvePreviewUrl({
  sessionUuid,
  port,
  httpDomain,
}: {
  sessionUuid: string;
  port: number;
  httpDomain?: string | null;
}): Pick<ChatPreviewPublication, 'url' | 'host' | 'path'> {
  const previewPath = buildPreviewPath(sessionUuid, port);
  const appUrl = new URL(APP_HOST);

  if (httpDomain?.trim()) {
    const host = `${buildResourceName('chat', sessionUuid, port)}.${httpDomain.trim()}`;
    return {
      url: `${appUrl.protocol}//${host}`,
      host,
      path: '/',
    };
  }

  return {
    url: new URL(previewPath, APP_HOST).toString(),
    host: appUrl.hostname,
    path: previewPath,
  };
}

async function upsertService(coreApi: k8s.CoreV1Api, namespace: string, service: k8s.V1Service): Promise<void> {
  try {
    const existing = await coreApi.readNamespacedService(service.metadata!.name!, namespace);
    service.metadata = {
      ...(service.metadata || {}),
      resourceVersion: existing.body.metadata?.resourceVersion,
    };
    await coreApi.replaceNamespacedService(service.metadata!.name!, namespace, service);
  } catch (error) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      await coreApi.createNamespacedService(namespace, service);
      return;
    }

    throw error;
  }
}

async function upsertIngress(
  networkingApi: k8s.NetworkingV1Api,
  namespace: string,
  ingress: k8s.V1Ingress
): Promise<void> {
  try {
    const existing = await networkingApi.readNamespacedIngress(ingress.metadata!.name!, namespace);
    ingress.metadata = {
      ...(ingress.metadata || {}),
      resourceVersion: existing.body.metadata?.resourceVersion,
    };
    await networkingApi.replaceNamespacedIngress(ingress.metadata!.name!, namespace, ingress);
  } catch (error) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      await networkingApi.createNamespacedIngress(namespace, ingress);
      return;
    }

    throw error;
  }
}

export async function createOrUpdateChatPreview({
  sessionUuid,
  namespace,
  podName,
  port,
}: {
  sessionUuid: string;
  namespace: string;
  podName: string;
  port: number;
}): Promise<ChatPreviewPublication> {
  const { coreApi, networkingApi } = getClients();
  const { lifecycleDefaults, domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const publication = resolvePreviewUrl({
    sessionUuid,
    port,
    httpDomain: domainDefaults?.http,
  });
  const serviceName = buildResourceName('agent-preview', sessionUuid, port);
  const ingressName = buildResourceName('agent-preview-ingress', sessionUuid, port);
  const labels = {
    ...buildLifecycleLabels(),
    'app.kubernetes.io/component': 'agent-session-preview',
    'lfc/agent-session': sessionUuid,
  };

  const service: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName,
      namespace,
      labels,
    },
    spec: {
      selector: {
        'app.kubernetes.io/name': podName,
      },
      ports: [
        {
          name: 'http',
          port: 80,
          targetPort: port,
        },
      ],
    },
  };

  const ingressAnnotations: Record<string, string> = {};
  const pathRule =
    publication.path === '/'
      ? {
          path: '/',
          pathType: 'Prefix' as const,
        }
      : {
          path: `${publication.path}(/|$)(.*)`,
          pathType: 'ImplementationSpecific' as const,
        };

  if (publication.path !== '/') {
    ingressAnnotations['nginx.ingress.kubernetes.io/use-regex'] = 'true';
    ingressAnnotations['nginx.ingress.kubernetes.io/rewrite-target'] = '/$2';
  }

  const ingress: k8s.V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: ingressName,
      namespace,
      labels,
      ...(Object.keys(ingressAnnotations).length > 0 ? { annotations: ingressAnnotations } : {}),
    },
    spec: {
      ingressClassName: lifecycleDefaults?.ingressClassName || 'nginx',
      rules: [
        {
          ...(publication.host ? { host: publication.host } : {}),
          http: {
            paths: [
              {
                ...pathRule,
                backend: {
                  service: {
                    name: serviceName,
                    port: {
                      number: 80,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };

  await upsertService(coreApi, namespace, service);
  await upsertIngress(networkingApi, namespace, ingress);

  return {
    ...publication,
    serviceName,
    ingressName,
    port,
  };
}
