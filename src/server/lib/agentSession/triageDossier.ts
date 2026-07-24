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
  ): Promise<{ body: { items: PodLike[] } }>;
  listNamespacedEvent(
    namespace: string,
    pretty?: string,
    allowWatchBookmarks?: boolean,
    _continue?: string,
    fieldSelector?: string
  ): Promise<{ body: { items: EventLike[] } }>;
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

function deployName(deploy: TriageDeployInput): string {
  return deploy.deployable?.name || deploy.uuid || 'unknown';
}

function isFailureStatus(status: string | null | undefined): boolean {
  return Boolean(status && TERMINAL_FAILURE_STATUSES.has(status));
}

function compactLine(value: string | null | undefined, max = 350): string {
  const compact = (value || '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

// Tail of a log capped to maxChars, keeping the error window when present.
function logTail(content: string, maxChars = LOG_TAIL_MAX): string {
  return OutputLimiter.truncateLogOutput(content.trim(), maxChars, 5, 40);
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

function podLooksCrashLooping(pod: PodLike): boolean {
  return (pod.status?.containerStatuses || []).some(
    (c) => c.state?.waiting?.reason === 'CrashLoopBackOff' || (c.restartCount || 0) > 0
  );
}

async function collectRuntimeEvidence(
  deploy: TriageDeployInput,
  namespace: string,
  coreApi: TriageCoreApi
): Promise<string[]> {
  const lines: string[] = [];
  const podsResp = await coreApi.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    `deploy_uuid=${deploy.uuid}`
  );
  // Same job-pod filter as waitForDeployPodReady; Succeeded excludes completed build job pods.
  const pods = (podsResp.body.items || []).filter(
    (pod) => !pod.metadata?.name?.includes('-deploy-') && pod.status?.phase !== 'Succeeded'
  );
  const failingPods = pods.filter((pod) => !podIsReady(pod));

  if (failingPods.length === 0) {
    lines.push(
      pods.length === 0 ? '- no pods found for this deploy' : '- all pods currently Ready (failure may be stale)'
    );
    return lines;
  }

  for (const pod of failingPods.slice(0, MAX_FAILING_PODS)) {
    const causes = [
      ...(pod.status?.initContainerStatuses || []).map((s) => summarizeContainer(s, true)),
      ...(pod.status?.containerStatuses || []).map((s) => summarizeContainer(s, false)),
    ].filter((cause): cause is string => Boolean(cause));
    const detail = causes.length ? causes.join('; ') : `phase=${pod.status?.phase || 'unknown'}`;
    lines.push(`- pod ${pod.metadata?.name}: ${detail}`);
  }
  if (failingPods.length > MAX_FAILING_PODS) {
    lines.push(`- (+${failingPods.length - MAX_FAILING_PODS} more failing pods)`);
  }

  const failingPodNames = new Set(failingPods.map((pod) => pod.metadata?.name).filter(Boolean));
  try {
    const eventsResp = await coreApi.listNamespacedEvent(namespace);
    const warnings = (eventsResp.body.items || [])
      .filter((event) => event.type === 'Warning' && failingPodNames.has(event.involvedObject?.name))
      .slice(-MAX_WARNING_EVENTS);
    for (const event of warnings) {
      const count = event.count && event.count > 1 ? ` (x${event.count})` : '';
      lines.push(`- event: ${event.reason} ${compactLine(event.message, 200)}${count}`);
    }
  } catch (error) {
    lines.push(`- events unavailable: ${compactLine((error as Error)?.message || String(error), 120)}`);
  }

  const crashLooper = failingPods.find(podLooksCrashLooping);
  if (crashLooper?.metadata?.name) {
    try {
      const logResp = await coreApi.readNamespacedPodLog(
        crashLooper.metadata.name,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        40
      );
      if (logResp.body?.trim()) {
        lines.push(`- previous logs (${crashLooper.metadata.name}):`, ...fencedLog(logTail(logResp.body, 1800)));
      }
    } catch {
      lines.push(`- previous logs unavailable for ${crashLooper.metadata.name}`);
    }
  }

  return lines;
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

/**
 * Deterministic failure evidence for the Debug agent's system prompt. Returns the dossier body
 * (no header) when the build or an active deploy is in a terminal failure state, else null.
 */
export async function buildTriageDossier(
  build: TriageBuildInput,
  deploys: TriageDeployInput[],
  options: TriageDossierOptions = {}
): Promise<string | null> {
  const activeDeploys = deploys.filter((deploy) => deploy.active !== false);
  const failingDeploys = activeDeploys.filter((deploy) => isFailureStatus(deploy.status));
  const buildFailing = isFailureStatus(build.status);

  if (!buildFailing && failingDeploys.length === 0) {
    return null;
  }

  const blocks: string[] = [];

  if (build.status === 'config_error' || build.status === 'error') {
    // Schema-validation failures carry jsonschema paths; the matching schema slices give the
    // valid shape of exactly the failing fields (empty for non-schema errors).
    const schemaSlices = renderLifecycleSchemaSlices(build.statusMessage || '');
    blocks.push(
      renderBlock(`## environment — phase=config status=${build.status}`, [
        `- buildStatusMessage: ${compactLine(build.statusMessage) || '<none>'}`,
        ...(schemaSlices ? ['Relevant lifecycle.yaml schema for the failing paths:', schemaSlices] : []),
      ])
    );
  }

  const failingNames = failingDeploys.map(deployName);
  let coreApi = options.coreApi;
  const getCoreApi = async (): Promise<TriageCoreApi> => {
    if (!coreApi) {
      const k8s = await import('@kubernetes/client-node');
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      coreApi = kc.makeApiClient(k8s.CoreV1Api) as unknown as TriageCoreApi;
    }
    return coreApi;
  };

  for (const [index, deploy] of failingDeploys.entries()) {
    const phase = classifyDeployPhase(deploy);
    const header = `## ${deployName(deploy)} — phase=${phase} status=${deploy.status}`;

    if (index >= MAX_DETAILED_DEPLOYS) {
      blocks.push(`${header} (evidence omitted: ${compactLine(deploy.statusMessage, 160) || 'see statusMessage'})`);
      continue;
    }

    const lines: string[] = [];
    if (deploy.statusMessage) {
      lines.push(`- statusMessage: ${compactLine(deploy.statusMessage)}`);
    }

    if (phase === 'runtime') {
      if (!build.namespace) {
        lines.push('- k8s evidence unavailable: build namespace unknown');
      } else {
        try {
          lines.push(...(await collectRuntimeEvidence(deploy, build.namespace, await getCoreApi())));
        } catch (error) {
          lines.push(`- k8s evidence unavailable: ${compactLine((error as Error)?.message || String(error), 200)}`);
        }
      }
    } else if (deploy.buildOutput?.trim()) {
      lines.push(`- ${phase} logs (tail):`, ...fencedLog(logTail(deploy.buildOutput)));
    } else {
      lines.push(`- ${phase} logs unavailable (no persisted buildOutput)`);
    }

    blocks.push(renderBlock(header, lines));
  }

  const blockedDeploys = activeDeploys.filter(
    (deploy) => deploy.status === 'queued' && (failingDeploys.length > 0 || buildFailing)
  );
  for (const deploy of blockedDeploys) {
    blocks.push(
      renderBlock(`## ${deployName(deploy)} — phase=blocked status=queued`, [
        `- blocked: waiting on failed deploy ${blockerNameFor(deploy, failingNames)}`,
      ])
    );
  }

  if (blocks.length === 0) {
    blocks.push(
      renderBlock(
        `## environment — phase=${build.status === 'build_failed' ? 'build' : 'deploy'} status=${build.status}`,
        [`- buildStatusMessage: ${compactLine(build.statusMessage) || '<none>'}`]
      )
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
