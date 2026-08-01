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

import { OutputLimiter } from 'server/services/agent/tools/outputLimiter';
import { renderLifecycleSchemaSlices } from 'server/lib/yamlSchemas/schemaSlice';
import { scrubSecretsFromText } from 'server/lib/secretScrub';
import {
  MAX_LOG_FETCH_BYTES,
  readNamespaceEventsBounded,
  type DiagnosticCoreApi,
} from 'server/lib/kubernetes/diagnosticReaders';

export type TriagePhase = 'config' | 'build' | 'deploy' | 'runtime' | 'blocked';

export interface TriageBuildInput {
  uuid?: string;
  status?: string | null;
  statusMessage?: string | null;
  namespace?: string | null;
}

export interface TriageDeployInput {
  uuid?: string;
  status?: string | null;
  statusMessage?: string | null;
  buildOutput?: string | null;
  active?: boolean;
  provider?: 'kubernetes' | 'codefresh';
  deployable?: { name?: string; deploymentDependsOn?: string[] } | null;
  service?: { name?: string } | null;
}

type PodContainerState = {
  name?: string;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; message?: string; exitCode?: number };
  };
  lastState?: { terminated?: { reason?: string; message?: string; exitCode?: number } };
};

type PodLike = {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
    containerStatuses?: PodContainerState[];
    initContainerStatuses?: PodContainerState[];
  };
};

type EventLike = {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  involvedObject?: { name?: string };
  lastTimestamp?: unknown;
  eventTime?: unknown;
};

export interface TriageCoreApi {
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

export interface TriageDossierOptions {
  coreApi?: TriageCoreApi;
  pinnedServices?: readonly string[];
}

export interface TriageRuntimeEvidence {
  stateNote?: string;
  podSummaries: string[];
  omittedFailingPods: number;
  warningEvents: string[];
  eventsUnavailable?: string;
  previousLog?: { podName: string; content: string };
  previousLogUnavailableFor?: string;
  unavailable?: string;
}

export interface TriageServiceEvidence {
  name: string;
  phase: TriagePhase;
  status: string;
  statusMessage?: string;
  detailed: boolean;
  omittedMessage?: string;
  runtime?: TriageRuntimeEvidence;
  logTail?: string;
  logsUnavailable?: boolean;
  unsupportedProvider?: 'codefresh';
}

export interface TriageEvidence {
  buildStatus: string;
  config?: {
    status: string;
    statusMessage: string;
    schemaSlices?: string;
  };
  failingServices: TriageServiceEvidence[];
  blockedServices: Array<{ name: string; blocker: string }>;
  fallback?: { phase: 'build' | 'deploy' | 'orchestration'; statusMessage: string };
}

const TERMINAL_FAILURE_STATUSES = new Set(['error', 'config_error', 'build_failed', 'deploy_failed']);
const PER_DEPLOY_EVIDENCE_MAX = 3500;
const TOTAL_DOSSIER_MAX = 12000;
const MAX_DETAILED_DEPLOYS = 4;
// Small enough that MAX_DETAILED_DEPLOYS full blocks fit under TOTAL_DOSSIER_MAX.
const LOG_TAIL_MAX = 2500;
const MAX_FAILING_PODS = 3;
const MAX_WARNING_EVENTS = 5;
const POD_NOT_READY_RE = /pods? failed to become ready/i;
const DEFAULT_TRIAGE_TIMEBOX_MS = 4_000;

function deployName(deploy: TriageDeployInput): string {
  return deploy.deployable?.name || deploy.uuid || 'unknown';
}

function isFailureStatus(status: string | null | undefined): boolean {
  return Boolean(status && TERMINAL_FAILURE_STATUSES.has(status));
}

function compactLine(value: string | null | undefined, max = 350): string {
  const compact = scrubSecretsFromText(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

// Tail of a log capped to maxChars, keeping the error window when present.
function logTail(content: string, maxChars = LOG_TAIL_MAX): string {
  return OutputLimiter.truncateLogOutput(scrubSecretsFromText(content).trim(), maxChars, 5, 40);
}

function fencedLog(content: string): string[] {
  return ['```log', content, '```'];
}

export function classifyDeployPhase(deploy: TriageDeployInput): TriagePhase {
  const status = deploy.status || '';
  const statusMessage = deploy.statusMessage || '';

  if (status === 'build_failed') return 'build';
  if (POD_NOT_READY_RE.test(statusMessage)) return 'runtime';
  if (status === 'deploy_failed') return 'deploy';
  if (/\b(build|ci)\b/i.test(statusMessage)) return 'build';
  return 'deploy';
}

function summarizeContainer(state: PodContainerState, init: boolean): string | undefined {
  const prefix = init ? 'init ' : '';
  const restarts = state.restartCount ? ` restarts=${state.restartCount}` : '';
  const waiting = state.state?.waiting;
  const terminated = state.state?.terminated || state.lastState?.terminated;

  if (waiting && waiting.reason !== 'ContainerCreating') {
    const message = compactLine(waiting.message || terminated?.message, 160);
    return `${prefix}${state.name} waiting=${waiting.reason || 'unknown'}${message ? ` (${message})` : ''}${restarts}`;
  }
  if (terminated && (terminated.reason !== 'Completed' || init)) {
    const message = compactLine(terminated.message, 160);
    const exit = terminated.exitCode !== undefined ? ` exit=${terminated.exitCode}` : '';
    return `${prefix}${state.name} terminated=${terminated.reason || 'unknown'}${exit}${
      message ? ` (${message})` : ''
    }${restarts}`;
  }
  if (state.restartCount) {
    return `${prefix}${state.name}${restarts}`;
  }
  return undefined;
}

function podIsReady(pod: PodLike): boolean {
  return pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') || false;
}

function crashLoopingContainer(pod: PodLike): PodContainerState | undefined {
  return [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])].find(
    (container) =>
      Boolean(container.name) &&
      (container.state?.waiting?.reason === 'CrashLoopBackOff' ||
        ((container.restartCount ?? 0) > 0 && Boolean(container.lastState?.terminated)))
  );
}

async function withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.max(1, deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('diagnostic read timed out')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectRuntimeEvidence(
  deploy: TriageDeployInput,
  namespace: string,
  coreApi: TriageCoreApi,
  deadline: number
): Promise<TriageRuntimeEvidence> {
  const evidence: TriageRuntimeEvidence = {
    podSummaries: [],
    omittedFailingPods: 0,
    warningEvents: [],
  };
  const podsResp = await withinDeadline(
    coreApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, `deploy_uuid=${deploy.uuid}`),
    deadline
  );
  // Same job-pod filter as waitForDeployPodReady; Succeeded excludes completed build job pods.
  const pods = (podsResp.body.items || []).filter(
    (pod) => !pod.metadata?.name?.includes('-deploy-') && pod.status?.phase !== 'Succeeded'
  );
  const failingPods = pods.filter((pod) => !podIsReady(pod));

  if (failingPods.length === 0) {
    evidence.stateNote =
      pods.length === 0 ? 'no pods found for this deploy' : 'all pods currently Ready (failure may be stale)';
    return evidence;
  }

  for (const pod of failingPods.slice(0, MAX_FAILING_PODS)) {
    const causes = [
      ...(pod.status?.initContainerStatuses || []).map((s) => summarizeContainer(s, true)),
      ...(pod.status?.containerStatuses || []).map((s) => summarizeContainer(s, false)),
    ].filter((cause): cause is string => Boolean(cause));
    const detail = causes.length ? causes.join('; ') : `phase=${pod.status?.phase || 'unknown'}`;
    evidence.podSummaries.push(`${pod.metadata?.name}: ${detail}`);
  }
  if (failingPods.length > MAX_FAILING_PODS) {
    evidence.omittedFailingPods = failingPods.length - MAX_FAILING_PODS;
  }

  const failingPodNames = new Set(failingPods.map((pod) => pod.metadata?.name).filter(Boolean));
  try {
    const eventResult = await readNamespaceEventsBounded(
      namespace,
      coreApi as unknown as Pick<DiagnosticCoreApi, 'listNamespacedEvent'>,
      {
        allowedObjectNames: failingPodNames as Set<string>,
        warningsOnly: true,
        sourceTail: true,
        maxWarnings: MAX_WARNING_EVENTS,
        maxNormal: 0,
        timeoutMs: Math.max(1, deadline - Date.now()),
      }
    );
    for (const event of eventResult.events) {
      const count = event.count && event.count > 1 ? ` (x${event.count})` : '';
      evidence.warningEvents.push(`${event.reason} ${compactLine(event.message, 200)}${count}`);
    }
  } catch (error) {
    evidence.eventsUnavailable = compactLine((error as Error)?.message || String(error), 120);
  }

  const crashLooper = failingPods
    .map((pod) => ({ pod, container: crashLoopingContainer(pod) }))
    .find(({ pod, container }) => Boolean(pod.metadata?.name && container?.name));
  if (crashLooper?.pod.metadata?.name && crashLooper.container?.name) {
    const podName = crashLooper.pod.metadata.name;
    const containerName = crashLooper.container.name;
    try {
      const logResp = await withinDeadline(
        coreApi.readNamespacedPodLog(
          podName,
          namespace,
          containerName,
          undefined,
          undefined,
          MAX_LOG_FETCH_BYTES,
          undefined,
          true,
          undefined,
          40
        ),
        deadline
      );
      if (logResp.body?.trim()) {
        evidence.previousLog = {
          podName,
          content: logTail(logResp.body, 1800),
        };
      }
    } catch {
      evidence.previousLogUnavailableFor = podName;
    }
  }

  return evidence;
}

function blockerNameFor(deploy: TriageDeployInput, failingNames: string[]): string {
  const declared = deploy.deployable?.deploymentDependsOn || [];
  return declared.find((dep) => failingNames.includes(dep)) || failingNames[0] || 'an earlier deploy';
}

function renderBlock(header: string, evidenceLines: string[]): string {
  const body = evidenceLines.join('\n');
  const capped = body.length > PER_DEPLOY_EVIDENCE_MAX ? `${body.slice(0, PER_DEPLOY_EVIDENCE_MAX)}…` : body;
  return capped ? `${header}\n${capped}` : header;
}

/** SECURITY: accepts no caller-selected namespace, label, pod, or job identifier; targets derive from the supplied rows. */
export async function collectTriageEvidence(
  build: TriageBuildInput,
  deploys: TriageDeployInput[],
  options: TriageDossierOptions = {}
): Promise<TriageEvidence | null> {
  const activeDeploys = deploys.filter((deploy) => deploy.active !== false);
  const failingDeploys = activeDeploys.filter((deploy) => isFailureStatus(deploy.status));
  const buildFailing = isFailureStatus(build.status);

  if (!buildFailing && failingDeploys.length === 0) {
    return null;
  }

  const evidence: TriageEvidence = {
    buildStatus: build.status || '',
    failingServices: [],
    blockedServices: [],
  };

  if (build.status === 'config_error') {
    // Schema-validation failures carry jsonschema paths; the matching schema slices give the
    // valid shape of exactly the failing fields (empty for non-schema errors).
    const schemaSlices = renderLifecycleSchemaSlices(build.statusMessage || '');
    evidence.config = {
      status: build.status,
      statusMessage: compactLine(build.statusMessage) || '<none>',
      ...(schemaSlices ? { schemaSlices: scrubSecretsFromText(schemaSlices) } : {}),
    };
  }

  const failingNames = failingDeploys.map(deployName);
  const pinned = new Set((options.pinnedServices ?? []).slice(0, MAX_DETAILED_DEPLOYS));
  const detailedNames = new Set<string>();
  for (const deploy of failingDeploys) {
    const name = deployName(deploy);
    if (pinned.has(name) && detailedNames.size < MAX_DETAILED_DEPLOYS) {
      detailedNames.add(name);
    }
  }
  for (const deploy of failingDeploys) {
    if (detailedNames.size >= MAX_DETAILED_DEPLOYS) break;
    detailedNames.add(deployName(deploy));
  }

  const deadline = Date.now() + DEFAULT_TRIAGE_TIMEBOX_MS;
  let coreApi = options.coreApi;
  const getCoreApi = async (): Promise<TriageCoreApi> => {
    if (!coreApi) {
      const k8s = await withinDeadline(import('@kubernetes/client-node'), deadline);
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      coreApi = kc.makeApiClient(k8s.CoreV1Api) as unknown as TriageCoreApi;
    }
    return coreApi;
  };

  for (const deploy of failingDeploys) {
    const phase = classifyDeployPhase(deploy);
    const serviceEvidence: TriageServiceEvidence = {
      name: compactLine(deployName(deploy), 100) || 'unknown',
      phase,
      status: compactLine(deploy.status, 100) || 'unknown',
      detailed: detailedNames.has(deployName(deploy)),
    };
    if (!serviceEvidence.detailed) {
      serviceEvidence.omittedMessage = compactLine(deploy.statusMessage, 160) || 'see statusMessage';
      evidence.failingServices.push(serviceEvidence);
      continue;
    }

    if (deploy.statusMessage) {
      serviceEvidence.statusMessage = compactLine(deploy.statusMessage);
    }
    if (deploy.provider === 'codefresh') {
      serviceEvidence.unsupportedProvider = 'codefresh';
      evidence.failingServices.push(serviceEvidence);
      continue;
    }

    if (phase === 'runtime') {
      if (!build.namespace) {
        serviceEvidence.runtime = {
          podSummaries: [],
          omittedFailingPods: 0,
          warningEvents: [],
          unavailable: 'build namespace unknown',
        };
      } else {
        try {
          serviceEvidence.runtime = await collectRuntimeEvidence(deploy, build.namespace, await getCoreApi(), deadline);
        } catch (error) {
          serviceEvidence.runtime = {
            podSummaries: [],
            omittedFailingPods: 0,
            warningEvents: [],
            unavailable: compactLine((error as Error)?.message || String(error), 200),
          };
        }
      }
    } else if (deploy.buildOutput?.trim()) {
      serviceEvidence.logTail = logTail(deploy.buildOutput);
    } else {
      serviceEvidence.logsUnavailable = true;
    }

    evidence.failingServices.push(serviceEvidence);
  }

  const blockedDeploys = activeDeploys.filter(
    (deploy) => deploy.status === 'queued' && (failingDeploys.length > 0 || buildFailing)
  );
  for (const deploy of blockedDeploys) {
    evidence.blockedServices.push({
      name: compactLine(deployName(deploy), 100) || 'unknown',
      blocker: compactLine(blockerNameFor(deploy, failingNames), 100),
    });
  }

  if (!evidence.config && evidence.failingServices.length === 0 && evidence.blockedServices.length === 0) {
    evidence.fallback = {
      phase: build.status === 'error' ? 'orchestration' : build.status === 'build_failed' ? 'build' : 'deploy',
      statusMessage: compactLine(build.statusMessage) || '<none>',
    };
  }

  return evidence;
}

export function renderTriageEvidence(evidence: TriageEvidence): string {
  const blocks: string[] = [];
  if (evidence.config) {
    blocks.push(
      renderBlock(`## environment — phase=config status=${evidence.config.status}`, [
        `- buildStatusMessage: ${evidence.config.statusMessage}`,
        ...(evidence.config.schemaSlices
          ? ['Relevant lifecycle.yaml schema for the failing paths:', evidence.config.schemaSlices]
          : []),
      ])
    );
  }

  for (const service of evidence.failingServices) {
    const header = `## ${service.name} — phase=${service.phase} status=${service.status}`;
    if (!service.detailed) {
      blocks.push(`${header} (evidence omitted: ${service.omittedMessage || 'see statusMessage'})`);
      continue;
    }

    const lines: string[] = [];
    if (service.statusMessage) {
      lines.push(`- statusMessage: ${service.statusMessage}`);
    }
    if (service.unsupportedProvider === 'codefresh') {
      lines.push('- diagnostic evidence unavailable: Codefresh pipelines are unsupported by this surface');
    } else if (service.runtime) {
      const runtime = service.runtime;
      if (runtime.unavailable) {
        lines.push(`- k8s evidence unavailable: ${runtime.unavailable}`);
      } else {
        if (runtime.stateNote) lines.push(`- ${runtime.stateNote}`);
        lines.push(...runtime.podSummaries.map((summary) => `- pod ${summary}`));
        if (runtime.omittedFailingPods > 0) {
          lines.push(`- (+${runtime.omittedFailingPods} more failing pods)`);
        }
        lines.push(...runtime.warningEvents.map((event) => `- event: ${event}`));
        if (runtime.eventsUnavailable) {
          lines.push(`- events unavailable: ${runtime.eventsUnavailable}`);
        }
        if (runtime.previousLog) {
          lines.push(`- previous logs (${runtime.previousLog.podName}):`, ...fencedLog(runtime.previousLog.content));
        }
        if (runtime.previousLogUnavailableFor) {
          lines.push(`- previous logs unavailable for ${runtime.previousLogUnavailableFor}`);
        }
      }
    } else if (service.logTail) {
      lines.push(`- ${service.phase} logs (tail):`, ...fencedLog(service.logTail));
    } else if (service.logsUnavailable) {
      lines.push(`- ${service.phase} logs unavailable (no persisted buildOutput)`);
    }
    blocks.push(renderBlock(header, lines));
  }

  for (const blocked of evidence.blockedServices) {
    blocks.push(
      renderBlock(`## ${blocked.name} — phase=blocked status=queued`, [
        `- blocked: waiting on failed deploy ${blocked.blocker}`,
      ])
    );
  }

  if (evidence.fallback) {
    blocks.push(
      renderBlock(`## environment — phase=${evidence.fallback.phase} status=${evidence.buildStatus}`, [
        `- buildStatusMessage: ${evidence.fallback.statusMessage}`,
      ])
    );
  }

  let total = 0;
  const rendered: string[] = [];
  for (const block of blocks) {
    if (total + block.length > TOTAL_DOSSIER_MAX) {
      rendered.push('- (further evidence omitted: dossier size cap reached)');
      break;
    }
    rendered.push(block);
    total += block.length + 1;
  }

  return rendered.join('\n');
}

/** Deterministic failure evidence for the Debug agent; null unless the build or an active deploy failed terminally. */
export async function buildTriageDossier(
  build: TriageBuildInput,
  deploys: TriageDeployInput[],
  options: TriageDossierOptions = {}
): Promise<string | null> {
  const evidence = await collectTriageEvidence(build, deploys, options);
  return evidence ? renderTriageEvidence(evidence) : null;
}
