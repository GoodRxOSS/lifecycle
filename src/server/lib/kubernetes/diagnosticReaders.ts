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

import { redactExternalText } from 'server/lib/externalText';
import { truncateUtf8Tail } from 'server/lib/truncateUtf8';
import { OutputLimiter } from 'server/services/agent/tools/outputLimiter';
import { getEnvironmentPodsInNamespace, type EnvironmentPodCoreApi } from './getEnvironmentPods';

const TARGET_MARKER = Symbol('diagnostic-target');
const MAX_PODS = 100;
const MAX_CONTAINERS = 20;
const MAX_EVENTS = 60;
const MAX_WARNING_EVENTS = 50;
const MAX_LOG_BYTES = 30 * 1024;
export const MAX_LOG_FETCH_BYTES = 64 * 1024;
const MAX_LOG_LINES = 2_000;
const MAX_LINE_CHARS = 2_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 4_000;

export type DiagnosticReadErrorCode =
  | 'invalid_body'
  | 'job_not_found'
  | 'logs_not_found'
  | 'service_not_found'
  | 'unsupported_log_source'
  | 'upstream_unavailable';

export class DiagnosticReadError extends Error {
  constructor(readonly code: DiagnosticReadErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'DiagnosticReadError';
  }
}

export interface DiagnosticBuildRow {
  uuid: string;
  namespace?: string | null;
}

export interface DiagnosticServiceRow {
  name: string;
  deployUuid: string;
  provider: 'kubernetes' | 'codefresh';
}

export interface DiagnosticServiceTarget extends DiagnosticServiceRow {
  readonly [TARGET_MARKER]: true;
}

export interface DiagnosticTarget {
  uuid: string;
  namespace: string | null;
  services: readonly DiagnosticServiceTarget[];
  readonly [TARGET_MARKER]: true;
}

/** SECURITY: accepts only rows already resolved from the authorized build, never request objects. */
export function deriveDiagnosticTarget(
  build: DiagnosticBuildRow,
  services: readonly DiagnosticServiceRow[]
): DiagnosticTarget {
  return {
    uuid: build.uuid,
    namespace: build.namespace?.trim() || null,
    services: services.map((service) => ({
      ...service,
      [TARGET_MARKER]: true,
    })),
    [TARGET_MARKER]: true,
  };
}

export function resolveDiagnosticService(target: DiagnosticTarget, serviceName: string): DiagnosticServiceTarget {
  const service = target.services.find((candidate) => candidate.name === serviceName);
  if (!service) {
    throw new DiagnosticReadError('service_not_found', `No service named ${serviceName} exists.`, {
      validServices: target.services
        .map((candidate) => candidate.name)
        .sort()
        .slice(0, 100),
    });
  }

  return service;
}

type ContainerState = {
  waiting?: { reason?: string };
  running?: Record<string, unknown>;
  terminated?: { reason?: string; exitCode?: number };
};

type ContainerStatusLike = {
  name?: string;
  restartCount?: number;
  state?: ContainerState;
  lastState?: ContainerState;
};

type PodLike = {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    creationTimestamp?: Date | string;
  };
  spec?: {
    containers?: Array<{ name?: string }>;
    initContainers?: Array<{ name?: string }>;
  };
  status?: {
    phase?: string;
    startTime?: Date | string;
    conditions?: Array<{ type?: string; status?: string }>;
    containerStatuses?: ContainerStatusLike[];
    initContainerStatuses?: ContainerStatusLike[];
  };
};

type EventLike = {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  involvedObject?: { kind?: string; name?: string };
  lastTimestamp?: Date | string;
  eventTime?: Date | string;
};

export interface DiagnosticCoreApi {
  listNamespacedPod(
    namespace: string,
    pretty?: string,
    allowWatchBookmarks?: boolean,
    _continue?: string,
    fieldSelector?: string,
    labelSelector?: string
  ): Promise<{ body: { items?: PodLike[] } }>;
  listNamespacedEvent(
    namespace: string,
    pretty?: string,
    allowWatchBookmarks?: boolean,
    _continue?: string,
    fieldSelector?: string
  ): Promise<{ body: { items?: EventLike[] } }>;
  readNamespacedPodLog(
    name: string,
    namespace: string,
    container?: string,
    follow?: boolean,
    insecureSkipTLSVerifyBackend?: boolean,
    limitBytes?: number,
    pretty?: string,
    previous?: boolean,
    sinceSeconds?: number,
    tailLines?: number
  ): Promise<{ body: string }>;
}

export interface DiagnosticPod {
  name: string;
  service: string;
  status: string;
  ready: string;
  restarts: number;
  ageSeconds: number;
  containers: Array<{
    name: string;
    state: 'waiting' | 'running' | 'terminated' | 'unknown';
    reason?: string;
    restarts: number;
  }>;
}

export interface DiagnosticEvent {
  type: string;
  reason: string;
  object: string;
  message: string;
  count: number;
  lastSeen?: string;
}

export interface DiagnosticRuntimeLog {
  podName: string;
  container: string;
  content: string;
  totalLines: number;
  truncated: boolean;
  previous: boolean;
}

export interface NamespaceEventReadOptions {
  allowedObjectNames?: ReadonlySet<string>;
  warningsOnly?: boolean;
  sourceTail?: boolean;
  maxWarnings?: number;
  maxNormal?: number;
  timeoutMs?: number;
}

function requireNamespace(target: DiagnosticTarget): string {
  if (!target.namespace) {
    throw new DiagnosticReadError(
      'upstream_unavailable',
      'Kubernetes diagnostics are unavailable because this build has no namespace.'
    );
  }
  return target.namespace;
}

async function boundedCall<T>(work: Promise<T>, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DiagnosticReadError('upstream_unavailable', 'The diagnostics provider timed out.')),
          Math.max(1, timeoutMs)
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeText(value: unknown, maxBytes: number): string {
  return redactExternalText(value, maxBytes);
}

function appPods(items: readonly PodLike[]): PodLike[] {
  return items.filter((pod) => {
    const appName = pod.metadata?.labels?.['app.kubernetes.io/name'];
    return appName !== 'native-build' && appName !== 'native-helm';
  });
}

export async function readDiagnosticPods(
  target: DiagnosticTarget,
  coreApi: DiagnosticCoreApi,
  service?: DiagnosticServiceTarget
): Promise<{ pods: DiagnosticPod[]; truncated: boolean }> {
  const namespace = requireNamespace(target);
  const rows = await boundedCall(
    getEnvironmentPodsInNamespace(namespace, {
      coreV1: coreApi as unknown as EnvironmentPodCoreApi,
      labelSelector: service ? `deploy_uuid=${service.deployUuid}` : undefined,
      maxPods: MAX_PODS + 1,
    })
  );
  const pods = rows.slice(0, MAX_PODS).map((pod) => {
    const containers = pod.containers.slice(0, MAX_CONTAINERS).map((container) => ({
      name: safeText(container.name, 253),
      state: container.state.toLowerCase() as DiagnosticPod['containers'][number]['state'],
      ...(container.reason ? { reason: safeText(container.reason, 200) } : {}),
      restarts: Math.max(0, Math.trunc(container.restarts)),
    }));
    return {
      name: safeText(pod.podName, 253),
      service: safeText(pod.serviceName, 100),
      status: safeText(pod.status, 100),
      ready: pod.ready,
      restarts: Math.max(0, Math.trunc(pod.restarts)),
      ageSeconds: Math.max(0, Math.trunc(pod.ageSeconds)),
      containers,
    };
  });
  return { pods, truncated: rows.length > pods.length };
}

export async function readDiagnosticEvents(
  target: DiagnosticTarget,
  coreApi: DiagnosticCoreApi,
  service?: DiagnosticServiceTarget
): Promise<{ events: DiagnosticEvent[]; truncated: boolean }> {
  const namespace = requireNamespace(target);
  let allowedPodNames: Set<string> | undefined;
  if (service) {
    const podResponse = await boundedCall(
      coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `deploy_uuid=${service.deployUuid}`
      )
    );
    allowedPodNames = new Set(
      appPods(podResponse.body.items ?? [])
        .map((pod) => pod.metadata?.name)
        .filter((name): name is string => Boolean(name))
    );
  }
  return readNamespaceEventsBounded(namespace, coreApi, { allowedObjectNames: allowedPodNames });
}

/** SECURITY: namespace and allowed object names come only from server-derived build/pod state. */
export async function readNamespaceEventsBounded(
  namespace: string,
  coreApi: Pick<DiagnosticCoreApi, 'listNamespacedEvent'>,
  options: NamespaceEventReadOptions = {}
): Promise<{ events: DiagnosticEvent[]; truncated: boolean }> {
  const response = await boundedCall(coreApi.listNamespacedEvent(namespace), options.timeoutMs);
  const filtered = (response.body.items ?? []).filter(
    (event) =>
      (!options.allowedObjectNames || options.allowedObjectNames.has(event.involvedObject?.name ?? '')) &&
      (!options.warningsOnly || event.type === 'Warning')
  );
  const maxWarnings = Math.max(0, Math.min(MAX_WARNING_EVENTS, Math.trunc(options.maxWarnings ?? MAX_WARNING_EVENTS)));
  const maxNormal = Math.max(0, Math.min(MAX_EVENTS, Math.trunc(options.maxNormal ?? MAX_EVENTS - maxWarnings)));
  let selected: EventLike[];
  if (options.sourceTail) {
    selected = filtered.slice(-(maxWarnings + maxNormal));
  } else {
    const source = [...filtered].sort((left, right) => {
      const warningOrder = Number(right.type === 'Warning') - Number(left.type === 'Warning');
      if (warningOrder !== 0) return warningOrder;
      return (
        new Date(right.lastTimestamp ?? right.eventTime ?? 0).getTime() -
        new Date(left.lastTimestamp ?? left.eventTime ?? 0).getTime()
      );
    });
    const warnings = source.filter((event) => event.type === 'Warning').slice(0, maxWarnings);
    const normal = source.filter((event) => event.type !== 'Warning').slice(0, maxNormal);
    selected = [...warnings, ...normal];
  }
  return {
    events: selected.map((event) => {
      const seen = event.lastTimestamp ?? event.eventTime;
      return {
        type: safeText(event.type ?? 'Unknown', 100),
        reason: safeText(event.reason ?? 'Unknown', 200),
        object: safeText(`${event.involvedObject?.kind ?? 'object'}/${event.involvedObject?.name ?? 'unknown'}`, 500),
        message: safeText(event.message, 1_000),
        count: Math.max(0, Math.trunc(event.count ?? 0)),
        ...(seen ? { lastSeen: new Date(seen).toISOString() } : {}),
      };
    }),
    truncated: filtered.length > selected.length,
  };
}

// App containers first: the omitted-container default takes the first entry.
function containerNames(pod: PodLike): string[] {
  return [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]
    .map((container) => container.name)
    .filter((name): name is string => Boolean(name))
    .slice(0, MAX_CONTAINERS);
}

function newestPod(pods: PodLike[]): PodLike | undefined {
  return [...pods].sort(
    (left, right) =>
      new Date(right.metadata?.creationTimestamp ?? 0).getTime() -
      new Date(left.metadata?.creationTimestamp ?? 0).getTime()
  )[0];
}

function boundedLog(
  raw: string,
  source: { lineCap?: number; byteCap?: number } = {}
): { content: string; totalLines: number; truncated: boolean } {
  const text = String(raw ?? '');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const allLines = body === '' ? [] : body.split('\n');
  // A fetch that fills its provider cap cannot prove the source ends there.
  const sourceAtCapacity =
    (source.lineCap !== undefined && allLines.length >= source.lineCap) ||
    (source.byteCap !== undefined && Buffer.byteLength(text, 'utf8') >= source.byteCap);
  const tailLines = allLines.slice(-MAX_LOG_LINES);
  const clampedLines = tailLines.map((line) =>
    safeText(OutputLimiter.clampLogLine(line).slice(0, MAX_LINE_CHARS), MAX_LINE_CHARS * 4)
  );
  const byteBound = truncateUtf8Tail(clampedLines.join('\n'), MAX_LOG_BYTES);
  return {
    content: byteBound.text,
    totalLines: allLines.length,
    truncated:
      sourceAtCapacity ||
      allLines.length > tailLines.length ||
      byteBound.truncated ||
      tailLines.some((line, index) => line !== clampedLines[index]),
  };
}

export async function readDiagnosticRuntimeLog(
  target: DiagnosticTarget,
  service: DiagnosticServiceTarget,
  coreApi: DiagnosticCoreApi,
  options: { container?: string; previous?: boolean; tailLines?: number } = {}
): Promise<DiagnosticRuntimeLog> {
  if (service.provider === 'codefresh') {
    throw new DiagnosticReadError(
      'unsupported_log_source',
      'Codefresh pipeline logs are not available through Lifecycle diagnostics.'
    );
  }
  const namespace = requireNamespace(target);
  const response = await boundedCall(
    coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `deploy_uuid=${service.deployUuid}`
    )
  );
  const pod = newestPod(appPods(response.body.items ?? []));
  const podName = pod?.metadata?.name;
  if (!pod || !podName) {
    throw new DiagnosticReadError('logs_not_found', 'No runtime pod logs are available for this service.');
  }

  const choices = containerNames(pod);
  const container = options.container ?? choices[0];
  if (!container || !choices.includes(container)) {
    throw new DiagnosticReadError('invalid_body', 'Choose a container that exists in the current service pod.', {
      issues: [
        {
          path: '/source/container',
          message: `Choose one of: ${choices.join(', ') || '<none>'}`.slice(0, 500),
        },
      ],
    });
  }

  if (options.previous) {
    const status = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].find(
      (candidate) => candidate.name === container
    );
    if (!status || (status.restartCount ?? 0) < 1 || !status.lastState?.terminated) {
      throw new DiagnosticReadError(
        'logs_not_found',
        'No previous crashed container instance is available for this service.'
      );
    }
  }

  const requestedTailLines = Math.max(1, Math.min(MAX_LOG_LINES, Math.trunc(options.tailLines ?? 200)));
  const logResponse = await boundedCall(
    coreApi.readNamespacedPodLog(
      podName,
      namespace,
      container,
      undefined,
      undefined,
      MAX_LOG_FETCH_BYTES,
      undefined,
      options.previous === true,
      undefined,
      requestedTailLines
    )
  );
  const bounded = boundedLog(logResponse.body, { lineCap: requestedTailLines, byteCap: MAX_LOG_FETCH_BYTES });
  return {
    podName,
    container,
    ...bounded,
    previous: options.previous === true,
  };
}

export interface DiagnosticJob {
  jobName: string;
  status: 'Active' | 'Complete' | 'Failed' | 'Pending';
  podName?: string;
}

export interface DiagnosticJobLogDependencies {
  listJobs(kind: 'build' | 'deploy', serviceName: string, namespace: string): Promise<DiagnosticJob[]>;
  readLiveLog(
    podName: string,
    namespace: string,
    options: { limitBytes: number; tailLines: number }
  ): Promise<string | null>;
  readArchivedLog(
    kind: 'build' | 'deploy',
    serviceName: string,
    jobName: string,
    namespace: string,
    maxBytes: number
  ): Promise<{ logs: string; truncated: boolean } | null>;
}

export interface DiagnosticJobLog {
  jobName: string;
  jobStatus: DiagnosticJob['status'];
  logSource: 'live' | 'archived';
  content: string;
  totalLines: number;
  truncated: boolean;
}

export function createDiagnosticJobLogDependencies(coreApi: DiagnosticCoreApi): DiagnosticJobLogDependencies {
  return {
    listJobs: async (kind, serviceName, namespace) => {
      if (kind === 'build') {
        const { getNativeBuildJobs } = await import('./getNativeBuildJobs');
        return getNativeBuildJobs(serviceName, namespace);
      }
      const { getDeploymentJobs } = await import('./getDeploymentJobs');
      return getDeploymentJobs(serviceName, namespace);
    },
    readLiveLog: async (podName, namespace, options) => {
      const response = await coreApi.readNamespacedPodLog(
        podName,
        namespace,
        undefined,
        undefined,
        undefined,
        options.limitBytes,
        undefined,
        undefined,
        undefined,
        options.tailLines
      );
      return response.body?.trim() || null;
    },
    readArchivedLog: async (kind, serviceName, jobName, namespace, maxBytes) => {
      const { getLogArchivalService } = await import('server/services/logArchival');
      return getLogArchivalService().getArchivedLogsTail(namespace, kind, serviceName, jobName, maxBytes);
    },
  };
}

export async function readDiagnosticJobLog(
  target: DiagnosticTarget,
  service: DiagnosticServiceTarget,
  kind: 'build' | 'deploy',
  requestedJobName: string | undefined,
  dependencies: DiagnosticJobLogDependencies
): Promise<DiagnosticJobLog> {
  if (service.provider === 'codefresh') {
    throw new DiagnosticReadError(
      'unsupported_log_source',
      'Codefresh pipeline logs are not available through Lifecycle diagnostics.'
    );
  }
  const namespace = requireNamespace(target);
  const jobs = (await boundedCall(dependencies.listJobs(kind, service.name, namespace))).slice(0, 100);
  if (jobs.length === 0) {
    throw new DiagnosticReadError('logs_not_found', `No ${kind} logs are available for this service.`);
  }
  const job = requestedJobName ? jobs.find((candidate) => candidate.jobName === requestedJobName) : jobs[0];
  if (!job) {
    throw new DiagnosticReadError('job_not_found', `No ${kind} job named ${requestedJobName} exists.`, {
      availableJobs: jobs.map((candidate) => candidate.jobName).slice(0, 100),
    });
  }

  if (job.podName) {
    try {
      const live = await boundedCall(
        dependencies.readLiveLog(job.podName, namespace, {
          limitBytes: MAX_LOG_FETCH_BYTES,
          tailLines: MAX_LOG_LINES,
        })
      );
      if (live) {
        return {
          jobName: job.jobName,
          jobStatus: job.status,
          logSource: 'live',
          ...boundedLog(live, { lineCap: MAX_LOG_LINES, byteCap: MAX_LOG_FETCH_BYTES }),
        };
      }
    } catch {
      // A cleaned-up or temporarily unreadable live pod must not suppress the archive fallback.
    }
  }

  const archived = await boundedCall(
    dependencies.readArchivedLog(kind, service.name, job.jobName, namespace, MAX_LOG_FETCH_BYTES)
  );
  if (archived) {
    const bounded = boundedLog(archived.logs);
    return {
      jobName: job.jobName,
      jobStatus: job.status,
      logSource: 'archived',
      ...bounded,
      truncated: archived.truncated || bounded.truncated,
    };
  }

  throw new DiagnosticReadError('logs_not_found', `No ${kind} logs are available for the selected job.`);
}
