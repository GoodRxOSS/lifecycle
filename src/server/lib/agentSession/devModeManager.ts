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
import { DevConfig } from 'server/models/yaml/YamlService';
import { getLogger } from 'server/lib/logger';
import { AGENT_WORKSPACE_ROOT, AGENT_WORKSPACE_SUBPATH } from './workspace';

const logger = getLogger();
const DEV_MODE_DEPLOYMENT_SNAPSHOT_ANNOTATION = 'lifecycle.goodrx.com/dev-mode-deployment-snapshot';
const DEV_MODE_SERVICE_SNAPSHOT_ANNOTATION = 'lifecycle.goodrx.com/dev-mode-service-snapshot';
const SAME_NODE_SELECTOR_KEY = 'kubernetes.io/hostname';

export interface DevModeOptions {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  pvcName: string;
  devConfig: DevConfig;
  requiredNodeName?: string;
}

export interface DevModeDeploymentSnapshot {
  deploymentName: string;
  containerName: string;
  replicas: number | null;
  image: string | null;
  command: string[] | null;
  workingDir: string | null;
  env: k8s.V1EnvVar[] | null;
  volumeMounts: k8s.V1VolumeMount[] | null;
  volumes: k8s.V1Volume[] | null;
  nodeSelector: Record<string, string> | null;
}

export interface DevModeServiceSnapshot {
  serviceName: string;
  ports: k8s.V1ServicePort[] | null;
}

export interface DevModeResourceSnapshot {
  deployment: DevModeDeploymentSnapshot;
  service: DevModeServiceSnapshot | null;
}

interface AppliedDeploymentTemplate {
  spec?: {
    replicas?: number;
    template?: {
      spec?: {
        nodeSelector?: Record<string, string>;
        containers?: Array<{
          name?: string;
          command?: string[];
          workingDir?: string;
          volumeMounts?: Array<{
            name?: string;
            mountPath?: string;
          }>;
        }>;
        volumes?: Array<{
          name?: string;
        }>;
      };
    };
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isNotFoundError(error: unknown): error is k8s.HttpError {
  return error instanceof k8s.HttpError && error.response?.statusCode === 404;
}

function selectorMatches(
  selector: Record<string, string> | undefined,
  expected: Record<string, string> | undefined
): boolean {
  if (!selector || !expected) {
    return false;
  }

  return Object.entries(expected).every(([key, value]) => selector[key] === value);
}

export class DevModeManager {
  private kc: k8s.KubeConfig;
  private appsApi: k8s.AppsV1Api;
  private coreApi: k8s.CoreV1Api;

  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
  }

  async enableDevMode(opts: DevModeOptions): Promise<DevModeResourceSnapshot> {
    const deployment = await this.resolveDeployment(opts.namespace, opts.deploymentName);
    const resolvedDeploymentName = deployment.metadata?.name || opts.deploymentName;
    const service = opts.devConfig.ports?.length
      ? await this.resolveService(opts.namespace, opts.serviceName, resolvedDeploymentName, deployment)
      : null;
    const snapshot = this.captureSnapshot(deployment, service);

    await this.patchDeployment(opts, deployment);

    if (service) {
      await this.patchService(opts, service);
    }

    logger.info(`Enabled dev mode: deployment=${resolvedDeploymentName} namespace=${opts.namespace}`);
    return snapshot;
  }

  async disableDevMode(
    namespace: string,
    deploymentName: string,
    serviceName?: string,
    snapshot?: DevModeResourceSnapshot | null
  ): Promise<void> {
    const deployment = await this.resolveDeployment(namespace, deploymentName);
    const resolvedDeploymentName = deployment.metadata?.name || deploymentName;

    if (snapshot?.deployment) {
      await this.restoreDeploymentFromSnapshot(namespace, deployment, snapshot.deployment);
    } else {
      await this.cleanupDeploymentPatch(namespace, resolvedDeploymentName, deployment);
    }

    if (serviceName) {
      try {
        const service = await this.resolveService(namespace, serviceName, resolvedDeploymentName, deployment);
        if (snapshot?.service) {
          await this.restoreServiceFromSnapshot(namespace, service, snapshot.service);
        } else {
          await this.cleanupServicePatch(namespace, service);
        }
      } catch (error) {
        logger.warn(
          `Failed to revert service ports during dev mode cleanup: service=${serviceName} namespace=${namespace} err=${
            (error as Error).message
          }`
        );
      }
    }

    logger.info(`Disabled dev mode patch: deployment=${resolvedDeploymentName} namespace=${namespace}`);
  }

  private async resolveDeployment(namespace: string, deploymentName: string): Promise<k8s.V1Deployment> {
    try {
      const response = await this.appsApi.readNamespacedDeployment(deploymentName, namespace);
      return response.body;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const namespaceSuffix = namespace.startsWith('env-') ? namespace.slice(4) : namespace;
    const { body } = await this.appsApi.listNamespacedDeployment(namespace);
    const candidates = body.items.filter((deployment) => {
      const metadataName = deployment.metadata?.name;
      const labels = deployment.metadata?.labels || {};

      return (
        metadataName === deploymentName ||
        metadataName === `${deploymentName}-${namespaceSuffix}` ||
        metadataName?.startsWith(`${deploymentName}-`) ||
        labels['tags.datadoghq.com/service'] === deploymentName ||
        labels['app.kubernetes.io/instance'] === deploymentName
      );
    });

    return (
      candidates.find((deployment) => deployment.metadata?.name === `${deploymentName}-${namespaceSuffix}`) ||
      candidates.find((deployment) => deployment.metadata?.name === deploymentName) ||
      candidates.find((deployment) => deployment.metadata?.labels?.['tags.datadoghq.com/service'] === deploymentName) ||
      candidates[0] ||
      Promise.reject(new Error(`Deployment not found for dev mode: ${deploymentName} in namespace ${namespace}`))
    );
  }

  private async resolveService(
    namespace: string,
    serviceName: string,
    deploymentName: string,
    deployment: k8s.V1Deployment
  ): Promise<k8s.V1Service> {
    for (const candidateName of [serviceName, deploymentName]) {
      try {
        const response = await this.coreApi.readNamespacedService(candidateName, namespace);
        return response.body;
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }

    const deploymentSelector = deployment.spec?.selector?.matchLabels;
    const { body } = await this.coreApi.listNamespacedService(namespace);
    const candidates = body.items.filter((service) => {
      const metadataName = service.metadata?.name;
      return (
        metadataName === deploymentName ||
        metadataName === serviceName ||
        selectorMatches(service.spec?.selector as Record<string, string> | undefined, deploymentSelector)
      );
    });

    return (
      candidates.find((service) => service.metadata?.name === deploymentName) ||
      candidates.find((service) => service.metadata?.name === serviceName) ||
      candidates.find((service) => !service.metadata?.name?.startsWith('internal-lb-')) ||
      candidates[0] ||
      Promise.reject(new Error(`Service not found for dev mode: ${serviceName} in namespace ${namespace}`))
    );
  }

  private async patchDeployment(opts: DevModeOptions, existing: k8s.V1Deployment): Promise<void> {
    const { namespace, pvcName, devConfig, requiredNodeName } = opts;
    const deploymentName = existing.metadata?.name || opts.deploymentName;
    const workDir = devConfig.workDir || '/workspace';
    const existingContainerName = existing.spec?.template?.spec?.containers?.[0]?.name || deploymentName;
    const deploymentSnapshot = this.buildDeploymentSnapshot(existing, existingContainerName);
    const nodeSelector = requiredNodeName
      ? {
          ...(existing.spec?.template?.spec?.nodeSelector || {}),
          [SAME_NODE_SELECTOR_KEY]: requiredNodeName,
        }
      : undefined;

    const patch = {
      metadata: {
        annotations: {
          [DEV_MODE_DEPLOYMENT_SNAPSHOT_ANNOTATION]: JSON.stringify(deploymentSnapshot),
        },
      },
      spec: {
        replicas: 1,
        template: {
          spec: {
            ...(nodeSelector ? { nodeSelector } : {}),
            volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: pvcName } }],
            containers: [
              {
                name: existingContainerName,
                image: devConfig.image,
                command: ['/bin/sh', '-c', devConfig.command],
                workingDir: workDir,
                env: Object.entries(devConfig.env || {}).map(([name, value]) => ({ name, value })),
                // Mount the shared repo root once and let workingDir target the service subdirectory.
                volumeMounts: [
                  { name: 'workspace', mountPath: AGENT_WORKSPACE_ROOT, subPath: AGENT_WORKSPACE_SUBPATH },
                ],
              },
            ],
          },
        },
      },
    };

    await this.appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  }

  private async patchService(opts: DevModeOptions, existing: k8s.V1Service): Promise<void> {
    const { namespace, devConfig } = opts;
    const serviceName = existing.metadata?.name || opts.serviceName;
    const devPort = devConfig.ports![0];
    const existingPorts = existing.spec?.ports || [];
    const serviceSnapshot = this.buildServiceSnapshot(existing);
    const patch = {
      metadata: {
        annotations: {
          [DEV_MODE_SERVICE_SNAPSHOT_ANNOTATION]: JSON.stringify(serviceSnapshot),
        },
      },
      spec: {
        ports:
          existingPorts.length > 0
            ? existingPorts.map((port) => ({
                ...(port.name ? { name: port.name } : {}),
                ...(port.protocol ? { protocol: port.protocol } : {}),
                ...(port.nodePort ? { nodePort: port.nodePort } : {}),
                ...(port.appProtocol ? { appProtocol: port.appProtocol } : {}),
                port: port.port ?? devPort,
                targetPort: devPort,
              }))
            : [{ port: devPort, targetPort: devPort }],
      },
    };

    await this.coreApi.patchNamespacedService(
      serviceName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    logger.info(`Patched service targetPort: service=${serviceName} port=${devPort}`);
  }

  private async cleanupDeploymentPatch(
    namespace: string,
    deploymentName: string,
    existing: k8s.V1Deployment
  ): Promise<void> {
    const deploymentSnapshot = this.getDeploymentSnapshot(existing);
    if (deploymentSnapshot) {
      await this.restoreDeploymentFromSnapshot(namespace, existing, deploymentSnapshot);
      return;
    }

    const desiredTemplate = this.getLastAppliedTemplate(existing);
    if (!desiredTemplate) {
      const fallbackPatch = this.buildFallbackCleanupPatch(existing);
      if (fallbackPatch.length === 0) {
        logger.warn(`Skipping dev mode cleanup; last-applied annotation missing deployment=${deploymentName}`);
        return;
      }

      logger.warn(`Using fallback dev mode cleanup; last-applied annotation missing deployment=${deploymentName}`);
      await this.appsApi.patchNamespacedDeployment(
        deploymentName,
        namespace,
        fallbackPatch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/json-patch+json' } }
      );
      return;
    }

    const liveSpec = existing.spec?.template?.spec;
    const liveContainers = liveSpec?.containers || [];
    const liveContainerIndex = liveContainers.findIndex(Boolean);
    if (liveContainerIndex < 0) {
      return;
    }

    const liveContainer = liveContainers[liveContainerIndex];
    const desiredContainer =
      desiredTemplate.spec?.template?.spec?.containers?.find((container) => container.name === liveContainer.name) ||
      desiredTemplate.spec?.template?.spec?.containers?.[liveContainerIndex];
    const desiredVolumes = desiredTemplate.spec?.template?.spec?.volumes || [];

    const patch: Array<Record<string, unknown>> = [];

    if (liveContainer.command && !desiredContainer?.command) {
      patch.push({ op: 'remove', path: `/spec/template/spec/containers/${liveContainerIndex}/command` });
    }

    if (liveContainer.workingDir && !desiredContainer?.workingDir) {
      patch.push({ op: 'remove', path: `/spec/template/spec/containers/${liveContainerIndex}/workingDir` });
    }

    const liveVolumeMounts = liveContainer.volumeMounts || [];
    const desiredVolumeMounts = desiredContainer?.volumeMounts || [];
    for (let index = liveVolumeMounts.length - 1; index >= 0; index--) {
      const mount = liveVolumeMounts[index];
      const isWorkspaceMount = mount.name === 'workspace' && mount.mountPath === AGENT_WORKSPACE_ROOT;
      const desiredHasMount = desiredVolumeMounts.some(
        (desiredMount) => desiredMount.name === mount.name && desiredMount.mountPath === mount.mountPath
      );

      if (isWorkspaceMount && !desiredHasMount) {
        patch.push({
          op: 'remove',
          path: `/spec/template/spec/containers/${liveContainerIndex}/volumeMounts/${index}`,
        });
      }
    }

    const liveVolumes = liveSpec?.volumes || [];
    for (let index = liveVolumes.length - 1; index >= 0; index--) {
      const volume = liveVolumes[index];
      const isWorkspaceVolume = volume.name === 'workspace';
      const desiredHasVolume = desiredVolumes.some((desiredVolume) => desiredVolume.name === volume.name);

      if (isWorkspaceVolume && !desiredHasVolume) {
        patch.push({ op: 'remove', path: `/spec/template/spec/volumes/${index}` });
      }
    }

    this.appendValuePatch(patch, '/spec/replicas', existing.spec?.replicas, desiredTemplate.spec?.replicas);
    this.appendValuePatch(
      patch,
      '/spec/template/spec/nodeSelector',
      liveSpec?.nodeSelector,
      desiredTemplate.spec?.template?.spec?.nodeSelector
    );

    if (patch.length === 0) {
      return;
    }

    await this.appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
    );
  }

  private async cleanupServicePatch(namespace: string, existing: k8s.V1Service): Promise<void> {
    const serviceName = existing.metadata?.name;
    if (!serviceName) {
      return;
    }

    const serviceSnapshot = this.getServiceSnapshot(existing);
    if (serviceSnapshot) {
      await this.restoreServiceFromSnapshot(namespace, existing, serviceSnapshot);
      return;
    }

    const annotation = existing.metadata?.annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
    if (!annotation) {
      logger.warn(`Skipping service port revert; last-applied annotation missing service=${serviceName}`);
      return;
    }

    let originalSpec: {
      spec?: { ports?: Array<{ name?: string; port?: number; targetPort?: number | string; protocol?: string }> };
    };
    try {
      originalSpec = JSON.parse(annotation);
    } catch {
      logger.warn(`Failed to parse last-applied service annotation: service=${serviceName}`);
      return;
    }

    const originalPorts = originalSpec.spec?.ports;
    if (!originalPorts || originalPorts.length === 0) {
      return;
    }

    const patch = {
      spec: {
        ports: originalPorts.map((port) => ({
          ...(port.name ? { name: port.name } : {}),
          ...(port.protocol ? { protocol: port.protocol } : {}),
          port: port.port,
          targetPort: port.targetPort ?? port.port,
        })),
      },
    };

    await this.coreApi.patchNamespacedService(
      serviceName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    logger.info(`Reverted service ports: service=${serviceName} namespace=${namespace}`);
  }

  private getLastAppliedTemplate(existing: k8s.V1Deployment): AppliedDeploymentTemplate | null {
    const annotation = existing.metadata?.annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
    if (!annotation) {
      return null;
    }

    try {
      return JSON.parse(annotation) as AppliedDeploymentTemplate;
    } catch (error) {
      logger.warn({ error }, 'Failed to parse last-applied deployment annotation during dev mode cleanup');
      return null;
    }
  }

  private buildDeploymentSnapshot(existing: k8s.V1Deployment, containerName: string): DevModeDeploymentSnapshot {
    const liveSpec = existing.spec?.template?.spec;
    const liveContainers = liveSpec?.containers || [];
    const liveContainer = liveContainers.find((container) => container.name === containerName) || liveContainers[0];

    return {
      deploymentName: existing.metadata?.name || '',
      containerName,
      replicas: existing.spec?.replicas ?? null,
      image: liveContainer?.image || null,
      command: liveContainer?.command ? deepClone(liveContainer.command) : null,
      workingDir: liveContainer?.workingDir || null,
      env: liveContainer?.env ? deepClone(liveContainer.env) : null,
      volumeMounts: liveContainer?.volumeMounts ? deepClone(liveContainer.volumeMounts) : null,
      volumes: liveSpec?.volumes ? deepClone(liveSpec.volumes) : null,
      nodeSelector: liveSpec?.nodeSelector ? deepClone(liveSpec.nodeSelector) : null,
    };
  }

  private buildServiceSnapshot(existing: k8s.V1Service): DevModeServiceSnapshot {
    return {
      serviceName: existing.metadata?.name || '',
      ports: existing.spec?.ports ? deepClone(existing.spec.ports) : null,
    };
  }

  private getDeploymentSnapshot(existing: k8s.V1Deployment): DevModeDeploymentSnapshot | null {
    const annotation = existing.metadata?.annotations?.[DEV_MODE_DEPLOYMENT_SNAPSHOT_ANNOTATION];
    if (!annotation) {
      return null;
    }

    try {
      return JSON.parse(annotation) as DevModeDeploymentSnapshot;
    } catch (error) {
      logger.warn({ error }, 'Failed to parse dev mode deployment snapshot annotation');
      return null;
    }
  }

  private getServiceSnapshot(existing: k8s.V1Service): DevModeServiceSnapshot | null {
    const annotation = existing.metadata?.annotations?.[DEV_MODE_SERVICE_SNAPSHOT_ANNOTATION];
    if (!annotation) {
      return null;
    }

    try {
      return JSON.parse(annotation) as DevModeServiceSnapshot;
    } catch (error) {
      logger.warn({ error }, 'Failed to parse dev mode service snapshot annotation');
      return null;
    }
  }

  private captureSnapshot(deployment: k8s.V1Deployment, service: k8s.V1Service | null): DevModeResourceSnapshot {
    const container =
      deployment.spec?.template?.spec?.containers?.[0] ||
      ({ name: deployment.metadata?.name || 'container' } as k8s.V1Container);

    return {
      deployment: {
        deploymentName: deployment.metadata?.name || '',
        containerName: container.name || deployment.metadata?.name || 'container',
        replicas: this.cloneValue(deployment.spec?.replicas ?? null),
        image: container.image || null,
        command: this.cloneValue(container.command ?? null),
        workingDir: container.workingDir ?? null,
        env: this.cloneValue(container.env ?? null),
        volumeMounts: this.cloneValue(container.volumeMounts ?? null),
        volumes: this.cloneValue(deployment.spec?.template?.spec?.volumes ?? null),
        nodeSelector: this.cloneValue(deployment.spec?.template?.spec?.nodeSelector ?? null),
      },
      service: service
        ? {
            serviceName: service.metadata?.name || '',
            ports: this.cloneValue(service.spec?.ports ?? null),
          }
        : null,
    };
  }

  private async restoreDeploymentFromSnapshot(
    namespace: string,
    existing: k8s.V1Deployment,
    snapshot: DevModeDeploymentSnapshot
  ): Promise<void> {
    const deploymentName = existing.metadata?.name || snapshot.deploymentName;
    const liveContainers = existing.spec?.template?.spec?.containers || [];
    const liveContainerIndex =
      liveContainers.findIndex((container) => container.name === snapshot.containerName) >= 0
        ? liveContainers.findIndex((container) => container.name === snapshot.containerName)
        : liveContainers.findIndex(Boolean);

    if (liveContainerIndex < 0) {
      return;
    }

    const liveContainer = liveContainers[liveContainerIndex];
    const patch: Array<Record<string, unknown>> = [];
    const containerPath = `/spec/template/spec/containers/${liveContainerIndex}`;

    if (existing.metadata?.annotations?.[DEV_MODE_DEPLOYMENT_SNAPSHOT_ANNOTATION]) {
      patch.push({
        op: 'remove',
        path: `/metadata/annotations/${DEV_MODE_DEPLOYMENT_SNAPSHOT_ANNOTATION.replace('/', '~1')}`,
      });
    }

    this.appendValuePatch(patch, `${containerPath}/image`, liveContainer.image, snapshot.image);
    this.appendValuePatch(patch, '/spec/replicas', existing.spec?.replicas, snapshot.replicas);
    this.appendValuePatch(patch, `${containerPath}/command`, liveContainer.command, snapshot.command);
    this.appendValuePatch(patch, `${containerPath}/workingDir`, liveContainer.workingDir, snapshot.workingDir);
    this.appendValuePatch(patch, `${containerPath}/env`, liveContainer.env, snapshot.env);
    this.appendValuePatch(patch, `${containerPath}/volumeMounts`, liveContainer.volumeMounts, snapshot.volumeMounts);
    this.appendValuePatch(
      patch,
      '/spec/template/spec/volumes',
      existing.spec?.template?.spec?.volumes,
      snapshot.volumes
    );
    this.appendValuePatch(
      patch,
      '/spec/template/spec/nodeSelector',
      existing.spec?.template?.spec?.nodeSelector,
      snapshot.nodeSelector
    );

    if (patch.length === 0) {
      return;
    }

    await this.appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
    );
  }

  private async restoreServiceFromSnapshot(
    namespace: string,
    existing: k8s.V1Service,
    snapshot: DevModeServiceSnapshot
  ): Promise<void> {
    const serviceName = existing.metadata?.name || snapshot.serviceName;
    const patch = {
      metadata: {
        annotations: {
          [DEV_MODE_SERVICE_SNAPSHOT_ANNOTATION]: null,
        },
      },
      spec: {
        ports: this.cloneValue(snapshot.ports ?? []),
      },
    };

    await this.coreApi.patchNamespacedService(
      serviceName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    logger.info(`Restored service ports from snapshot: service=${serviceName} namespace=${namespace}`);
  }

  private appendValuePatch(
    patch: Array<Record<string, unknown>>,
    path: string,
    liveValue: unknown,
    desiredValue: unknown
  ): void {
    const hasLiveValue = typeof liveValue !== 'undefined';
    const hasDesiredValue = desiredValue !== null && typeof desiredValue !== 'undefined';

    if (!hasDesiredValue) {
      if (hasLiveValue) {
        patch.push({ op: 'remove', path });
      }
      return;
    }

    if (!hasLiveValue) {
      patch.push({ op: 'add', path, value: this.cloneValue(desiredValue) });
      return;
    }

    if (JSON.stringify(liveValue) !== JSON.stringify(desiredValue)) {
      patch.push({ op: 'replace', path, value: this.cloneValue(desiredValue) });
    }
  }

  private cloneValue<T>(value: T): T {
    if (value == null) {
      return value;
    }

    return JSON.parse(JSON.stringify(value)) as T;
  }

  private buildFallbackCleanupPatch(existing: k8s.V1Deployment): Array<Record<string, string>> {
    const liveSpec = existing.spec?.template?.spec;
    const liveContainers = liveSpec?.containers || [];
    const liveContainerIndex = liveContainers.findIndex(Boolean);
    if (liveContainerIndex < 0) {
      return [];
    }

    const liveContainer = liveContainers[liveContainerIndex];
    const liveVolumeMounts = liveContainer.volumeMounts || [];
    const hasWorkspaceMount = liveVolumeMounts.some(
      (mount) => mount.name === 'workspace' && mount.mountPath === AGENT_WORKSPACE_ROOT
    );
    const hasWorkspaceWorkingDir = liveContainer.workingDir?.startsWith(AGENT_WORKSPACE_ROOT) ?? false;
    const isLikelyDevPatched = hasWorkspaceMount || hasWorkspaceWorkingDir;

    const patch: Array<Record<string, string>> = [];

    if (isLikelyDevPatched && liveContainer.command) {
      patch.push({ op: 'remove', path: `/spec/template/spec/containers/${liveContainerIndex}/command` });
    }

    if (hasWorkspaceWorkingDir) {
      patch.push({ op: 'remove', path: `/spec/template/spec/containers/${liveContainerIndex}/workingDir` });
    }

    for (let index = liveVolumeMounts.length - 1; index >= 0; index--) {
      const mount = liveVolumeMounts[index];
      const isWorkspaceMount = mount.name === 'workspace' && mount.mountPath === AGENT_WORKSPACE_ROOT;

      if (isWorkspaceMount) {
        patch.push({
          op: 'remove',
          path: `/spec/template/spec/containers/${liveContainerIndex}/volumeMounts/${index}`,
        });
      }
    }

    const liveVolumes = liveSpec?.volumes || [];
    for (let index = liveVolumes.length - 1; index >= 0; index--) {
      const volume = liveVolumes[index];
      if (volume.name === 'workspace') {
        patch.push({ op: 'remove', path: `/spec/template/spec/volumes/${index}` });
      }
    }

    const liveNodeSelector = liveSpec?.nodeSelector || {};
    if (liveNodeSelector[SAME_NODE_SELECTOR_KEY]) {
      if (Object.keys(liveNodeSelector).length === 1) {
        patch.push({ op: 'remove', path: '/spec/template/spec/nodeSelector' });
      } else {
        patch.push({
          op: 'remove',
          path: `/spec/template/spec/nodeSelector/${SAME_NODE_SELECTOR_KEY.replace('/', '~1')}`,
        });
      }
    }

    return patch;
  }
}
