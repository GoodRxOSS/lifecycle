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

import { createHash } from 'crypto';
import AgentMessage from 'server/models/AgentMessage';
import type AgentSession from 'server/models/AgentSession';
import type AgentThread from 'server/models/AgentThread';
import { getLogger } from 'server/lib/logger';
import {
  formatEnvironmentBuildLine,
  formatEnvironmentPullRequestLine,
  formatEnvironmentServiceLine,
  resolveAgentSessionPromptContext,
  resolveAgentSessionTriage,
  type AgentSessionPromptContext,
  type AgentSessionPromptServiceContext,
} from 'server/lib/agentSession/systemPrompt';
import AgentMessageStore, { ENVIRONMENT_STATE_METADATA_KIND } from './MessageStore';
import type { AgentUIMessage } from './types';
import type { AgentRunExecuteJob } from './RunQueueService';

export type EnvironmentStateTrigger = 'run_start' | 'rebuild_watch';

const logger = () => getLogger();

const FINGERPRINT_MESSAGE_MAX_CHARS = 200;
const ROSTER_HEALTHY_MAX = 5;
const DELTA_UNCHANGED_NAMES_MAX = 8;

type ServiceFingerprint = {
  name: string;
  active?: boolean;
  status?: string;
  statusMessage?: string;
  dockerImage?: string;
};

type EnvironmentFingerprint = {
  build?: { status?: string; statusMessage?: string; sha?: string };
  deploys: ServiceFingerprint[];
  pr?: { latestCommit?: string };
};

export type EnvironmentStateEventMetadata = {
  kind: typeof ENVIRONMENT_STATE_METADATA_KIND;
  trigger: EnvironmentStateTrigger;
  occurredAt: string;
  summary: string;
  fingerprint: string;
  buildUuid?: string;
  runUuid?: string;
  commitUrl?: string;
};

// Deterministic v4-shaped uuid so re-dispatched work upserts the same row instead of duplicating.
export function deterministicEventUuid(seed: string): string {
  const bytes = createHash('sha256').update(`env-state:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compactMessage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > FINGERPRINT_MESSAGE_MAX_CHARS
    ? `${compact.slice(0, FINGERPRINT_MESSAGE_MAX_CHARS)}…`
    : compact;
}

function fingerprintServices(context: AgentSessionPromptContext): AgentSessionPromptServiceContext[] {
  return context.diagnosticServices?.length ? context.diagnosticServices : context.services;
}

export function buildEnvironmentFingerprint(context: AgentSessionPromptContext): EnvironmentFingerprint {
  return {
    ...(context.build
      ? {
          build: {
            status: context.build.status,
            statusMessage: compactMessage(context.build.statusMessage),
            sha: context.build.sha,
          },
        }
      : {}),
    deploys: [...fingerprintServices(context)]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((service) => ({
        name: service.name,
        ...(service.active !== undefined ? { active: service.active } : {}),
        ...(service.status ? { status: service.status } : {}),
        ...(compactMessage(service.statusMessage) ? { statusMessage: compactMessage(service.statusMessage) } : {}),
        ...(service.dockerImage ? { dockerImage: service.dockerImage } : {}),
      })),
    ...(context.pullRequest?.latestCommit ? { pr: { latestCommit: context.pullRequest.latestCommit } } : {}),
  };
}

// Failure identity: which deploys are failing and why. Triage evidence is re-collected only when this changes.
export function buildFailureSignature(fingerprint: EnvironmentFingerprint): string {
  return JSON.stringify({
    build: { status: fingerprint.build?.status, statusMessage: fingerprint.build?.statusMessage },
    deploys: fingerprint.deploys
      .filter((deploy) => deploy.active !== false)
      .map((deploy) => ({ name: deploy.name, status: deploy.status, statusMessage: deploy.statusMessage })),
  });
}

function parseFingerprint(value: unknown): EnvironmentFingerprint | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as EnvironmentFingerprint;
    return Array.isArray(parsed?.deploys) ? parsed : null;
  } catch {
    return null;
  }
}

function isHealthyStatus(status: string | undefined): boolean {
  return status === 'deployed';
}

const TERMINAL_FAILURE_STATUSES = new Set(['error', 'config_error', 'build_failed', 'deploy_failed']);

/**
 * One line per failed service naming everything it transitively blocks — the graph slice that
 * answers "why is this queued" and "which failure is upstream" without a tool call. Empty when
 * nothing failed or no edges are declared.
 */
export function buildDependencyChainLines(services: AgentSessionPromptServiceContext[]): string[] {
  const failed = services.filter((service) => service.status && TERMINAL_FAILURE_STATUSES.has(service.status));
  if (failed.length === 0 || !services.some((service) => service.dependsOn?.length)) {
    return [];
  }

  const dependentsOf = new Map<string, string[]>();
  for (const service of services) {
    for (const dependency of service.dependsOn || []) {
      dependentsOf.set(dependency, [...(dependentsOf.get(dependency) || []), service.name]);
    }
  }

  const lines: string[] = [];
  for (const failure of failed) {
    const blocked = new Set<string>();
    const queue = [failure.name];
    while (queue.length > 0) {
      for (const dependent of dependentsOf.get(queue.shift()!) || []) {
        if (dependent !== failure.name && !blocked.has(dependent)) {
          blocked.add(dependent);
          queue.push(dependent);
        }
      }
    }
    if (blocked.size > 0) {
      lines.push(`- ${failure.name} (${failure.status}) blocks: ${[...blocked].sort().join(', ')}`);
    }
  }

  return lines.length > 0 ? ['Dependency chains:', ...lines] : [];
}

function stateHeader(asOf: string, trigger: EnvironmentStateTrigger): string {
  return `Environment state — as of ${asOf} (${trigger === 'run_start' ? 'run start' : 'rebuild watch'})`;
}

export function renderEnvironmentStateBlock(
  context: AgentSessionPromptContext,
  options: { asOf: string; trigger: EnvironmentStateTrigger; headline?: string }
): string {
  const lines = [stateHeader(options.asOf, options.trigger)];
  if (options.headline) {
    lines.push(options.headline);
  }

  const namespace = context.namespace || context.build?.namespace;
  if (namespace) {
    lines.push(`- namespace: ${namespace}`);
  }
  if (context.buildUuid) {
    lines.push(`- buildUuid: ${context.buildUuid}`);
  }
  if (context.lifecycleConfig) {
    lines.push(`- lifecycleConfig: ${context.lifecycleConfig.status} (${context.lifecycleConfig.path})`);
    if (context.lifecycleConfig.declaredServices?.length) {
      lines.push(`- declaredServices: ${context.lifecycleConfig.declaredServices.join(', ')}`);
    }
  }
  if (context.build) {
    lines.push(formatEnvironmentBuildLine(context.build));
  }
  if (context.pullRequest) {
    const prLine = formatEnvironmentPullRequestLine(context.pullRequest);
    if (prLine) {
      lines.push('Pull request:', prLine);
    }
  }

  const shouldListServices =
    !context.selectedDeploy &&
    context.services.length > 0 &&
    (context.userSelectedServices || !context.diagnosticServices?.length);
  if (shouldListServices) {
    lines.push('Selected services:');
    for (const service of [...context.services].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(formatEnvironmentServiceLine(service, 'full'));
    }
  }

  if (context.selectedDeploy) {
    lines.push('DEPLOYS — selected:', formatEnvironmentServiceLine(context.selectedDeploy, 'full'));
  }

  if (context.diagnosticServices?.length) {
    lines.push('DEPLOYS — roster:');
    const sorted = [...context.diagnosticServices].sort((left, right) => left.name.localeCompare(right.name));
    const noteworthy = sorted.filter((service) => !isHealthyStatus(service.status));
    const healthy = sorted.filter((service) => isHealthyStatus(service.status));
    for (const service of noteworthy) {
      lines.push(formatEnvironmentServiceLine(service, 'roster'));
    }
    for (const service of healthy.slice(0, ROSTER_HEALTHY_MAX)) {
      lines.push(formatEnvironmentServiceLine(service, 'roster'));
    }
    if (healthy.length > ROSTER_HEALTHY_MAX) {
      lines.push(
        `- (+${
          healthy.length - ROSTER_HEALTHY_MAX
        } more services with status=deployed — use query_database for the full list)`
      );
    }
    lines.push(...buildDependencyChainLines(sorted));
  }

  if (context.triage) {
    lines.push('Triage evidence (collected automatically):', context.triage);
  }

  return lines.join('\n');
}

type DeltaResult = {
  text: string;
  summary: string;
  changed: boolean;
  failureSignatureChanged: boolean;
};

export function renderEnvironmentStateDelta(
  previous: { fingerprint: EnvironmentFingerprint; occurredAt: string },
  next: { fingerprint: EnvironmentFingerprint; context: AgentSessionPromptContext },
  options: { asOf: string; trigger: EnvironmentStateTrigger; headline?: string }
): DeltaResult {
  const changes: string[] = [];
  const prevBuild = previous.fingerprint.build;
  const nextBuild = next.fingerprint.build;

  if (prevBuild?.status !== nextBuild?.status) {
    changes.push(`- build: ${prevBuild?.status || '<unknown>'} → ${nextBuild?.status || '<unknown>'}`);
  } else if (prevBuild?.statusMessage !== nextBuild?.statusMessage && nextBuild?.statusMessage) {
    changes.push(`- build statusMessage: ${nextBuild.statusMessage}`);
  }
  if (prevBuild?.sha !== nextBuild?.sha && nextBuild?.sha) {
    changes.push(`- build sha: ${prevBuild?.sha || '<none>'} → ${nextBuild.sha}`);
  }
  if (
    previous.fingerprint.pr?.latestCommit !== next.fingerprint.pr?.latestCommit &&
    next.fingerprint.pr?.latestCommit
  ) {
    changes.push(
      `- pull request: new commit ${next.fingerprint.pr.latestCommit}${
        previous.fingerprint.pr?.latestCommit ? ` (was ${previous.fingerprint.pr.latestCommit})` : ''
      }`
    );
  }

  const prevByName = new Map(previous.fingerprint.deploys.map((deploy) => [deploy.name, deploy]));
  const unchanged: string[] = [];
  for (const deploy of next.fingerprint.deploys) {
    const before = prevByName.get(deploy.name);
    prevByName.delete(deploy.name);
    if (!before) {
      changes.push(`- ${deploy.name}: added (status=${deploy.status || '<unknown>'})`);
      continue;
    }

    const parts: string[] = [];
    if (before.status !== deploy.status) {
      parts.push(`${before.status || '<unknown>'} → ${deploy.status || '<unknown>'}`);
    } else if (before.statusMessage !== deploy.statusMessage && deploy.statusMessage) {
      parts.push(`statusMessage: ${deploy.statusMessage}`);
    }
    if (before.dockerImage !== deploy.dockerImage && deploy.dockerImage) {
      parts.push(`image: ${deploy.dockerImage}`);
    }
    if (before.active !== deploy.active && deploy.active !== undefined) {
      parts.push(`active=${deploy.active}`);
    }

    if (parts.length > 0) {
      changes.push(`- ${deploy.name}: ${parts.join(', ')}`);
    } else {
      unchanged.push(deploy.name);
    }
  }
  for (const [name] of prevByName) {
    changes.push(`- ${name}: removed from roster`);
  }

  const failureSignatureChanged =
    buildFailureSignature(previous.fingerprint) !== buildFailureSignature(next.fingerprint);

  if (changes.length === 0) {
    const text = [
      `${stateHeader(options.asOf, options.trigger)}: no changes since ${previous.occurredAt}.`,
      ...(options.headline ? [options.headline] : []),
    ].join('\n');
    return { text, summary: 'no changes', changed: false, failureSignatureChanged: false };
  }

  const lines = [stateHeader(options.asOf, options.trigger)];
  if (options.headline) {
    lines.push(options.headline);
  }
  lines.push(`Changed since ${previous.occurredAt}:`, ...changes);
  if (unchanged.length > 0) {
    const names = unchanged.slice(0, DELTA_UNCHANGED_NAMES_MAX).join(', ');
    const more =
      unchanged.length > DELTA_UNCHANGED_NAMES_MAX ? `, +${unchanged.length - DELTA_UNCHANGED_NAMES_MAX} more` : '';
    lines.push(`- unchanged: ${names}${more}`);
  }
  if (failureSignatureChanged) {
    lines.push(...buildDependencyChainLines(fingerprintServices(next.context)));
  }

  const stillFailing = next.fingerprint.deploys.some((deploy) => deploy.status && !isHealthyStatus(deploy.status));
  if (next.context.triage && failureSignatureChanged) {
    lines.push('Triage evidence (collected automatically):', next.context.triage);
  } else if (stillFailing) {
    lines.push(
      failureSignatureChanged
        ? '- failure evidence: not collected — call get_environment_status for fresh evidence'
        : '- failure evidence: unchanged since the last state event'
    );
  }

  const summary = `${changes.length} change${changes.length === 1 ? '' : 's'}`;
  return { text: lines.join('\n'), summary, changed: true, failureSignatureChanged };
}

async function findLatestStateEvent(
  threadId: number
): Promise<{ fingerprint: EnvironmentFingerprint; occurredAt: string } | null> {
  const row = await AgentMessage.query()
    .where({ threadId, role: 'system' })
    .whereRaw(`metadata->>'kind' = ?`, [ENVIRONMENT_STATE_METADATA_KIND])
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .first();
  if (!row) {
    return null;
  }

  const fingerprint = parseFingerprint(row.metadata?.fingerprint);
  const occurredAt = typeof row.metadata?.occurredAt === 'string' ? row.metadata.occurredAt : null;
  return fingerprint && occurredAt ? { fingerprint, occurredAt } : null;
}

async function insertStateEvent({
  thread,
  uuid,
  runId,
  text,
  metadata,
}: {
  thread: Pick<AgentThread, 'id'>;
  uuid: string;
  runId?: number | null;
  text: string;
  metadata: EnvironmentStateEventMetadata;
}): Promise<boolean> {
  // Append-only: a row for this event id must never be rewritten with fresher state.
  const existing = await AgentMessage.query().findOne({ uuid });
  if (existing) {
    return false;
  }

  const message: AgentUIMessage = {
    id: uuid,
    role: 'system',
    metadata: metadata as unknown as AgentUIMessage['metadata'],
    parts: [{ type: 'text', text }],
  };
  await AgentMessageStore.upsertCanonicalUiMessagesForThread({ id: thread.id }, [message], { runId: runId ?? null });
  return true;
}

export default class EnvironmentStateService {
  /**
   * Appends the run-start environment-state event: a full snapshot for the thread's first event,
   * a delta (or one-line no-change confirmation) afterwards. Idempotent per run; approval resumes
   * continue the same logical turn and never re-snapshot. Never throws.
   */
  static async ensureRunStartStateEvent({
    session,
    thread,
    runUuid,
    runId,
    dispatchReason,
  }: {
    session: AgentSession;
    thread: Pick<AgentThread, 'id'>;
    runUuid: string;
    runId?: number | null;
    dispatchReason?: AgentRunExecuteJob['reason'];
  }): Promise<void> {
    if (dispatchReason === 'approval_resolved') {
      return;
    }
    if (!session.namespace && !session.buildUuid) {
      return;
    }

    const uuid = deterministicEventUuid(`run:${runUuid}`);
    try {
      const existing = await AgentMessage.query().findOne({ uuid });
      if (existing) {
        return;
      }

      const previous = await findLatestStateEvent(thread.id);
      const occurredAt = new Date().toISOString();
      // DB-only pass first; triage (live k8s I/O) only when this is the first event or the failure changed.
      const baseContext = await resolveAgentSessionPromptContext({
        sessionDbId: session.id,
        namespace: session.namespace || null,
        buildUuid: session.buildUuid,
        includeTriage: false,
      });
      const fingerprint = buildEnvironmentFingerprint(baseContext);

      const failureChanged =
        !previous || buildFailureSignature(previous.fingerprint) !== buildFailureSignature(fingerprint);
      const context = failureChanged
        ? { ...baseContext, triage: (await resolveAgentSessionTriage(session.buildUuid)) ?? undefined }
        : baseContext;

      let text: string;
      let summary: string;
      if (!previous) {
        text = renderEnvironmentStateBlock(context, { asOf: occurredAt, trigger: 'run_start' });
        summary = 'initial snapshot';
      } else {
        const delta = renderEnvironmentStateDelta(
          previous,
          { fingerprint, context },
          { asOf: occurredAt, trigger: 'run_start' }
        );
        text = delta.text;
        summary = delta.summary;
      }

      await insertStateEvent({
        thread,
        uuid,
        runId,
        text,
        metadata: {
          kind: ENVIRONMENT_STATE_METADATA_KIND,
          trigger: 'run_start',
          occurredAt,
          summary,
          fingerprint: JSON.stringify(fingerprint),
          ...(session.buildUuid ? { buildUuid: session.buildUuid } : {}),
          runUuid,
        },
      });
    } catch (error) {
      logger().warn({ error, runUuid }, `EnvState: run-start state event failed runId=${runUuid}`);
      // Disclose missing grounding instead of leaving the model with silence about the environment.
      await insertStateEvent({
        thread,
        uuid,
        runId,
        text:
          `Environment state — as of ${new Date().toISOString()} (run start): UNAVAILABLE (context lookup failed) — ` +
          'gather build/deploy/k8s state via tools and note that baseline context was unavailable.',
        metadata: {
          kind: ENVIRONMENT_STATE_METADATA_KIND,
          trigger: 'run_start',
          occurredAt: new Date().toISOString(),
          summary: 'state unavailable',
          fingerprint: '',
          ...(session.buildUuid ? { buildUuid: session.buildUuid } : {}),
          runUuid,
        },
      }).catch((insertError) => {
        logger().warn({ error: insertError, runUuid }, `EnvState: unavailable event insert failed runId=${runUuid}`);
      });
    }
  }

  /**
   * Appends a rebuild-watch state event (activity observed / terminal outcome). `uuidSeed` makes
   * re-processed watch jobs idempotent. Never throws.
   */
  static async postWatchStateEvent({
    session,
    thread,
    uuidSeed,
    headline,
    includeTriage,
    commitUrl,
  }: {
    session: Pick<AgentSession, 'id' | 'namespace' | 'buildUuid'>;
    thread: Pick<AgentThread, 'id'>;
    uuidSeed: string;
    headline: string;
    includeTriage: boolean;
    commitUrl?: string | null;
  }): Promise<void> {
    const uuid = deterministicEventUuid(`watch:${uuidSeed}`);
    try {
      const existing = await AgentMessage.query().findOne({ uuid });
      if (existing) {
        return;
      }

      const previous = await findLatestStateEvent(thread.id);
      const occurredAt = new Date().toISOString();
      const context = await resolveAgentSessionPromptContext({
        sessionDbId: session.id,
        namespace: session.namespace || null,
        buildUuid: session.buildUuid,
        includeTriage,
      });
      const fingerprint = buildEnvironmentFingerprint(context);

      let text: string;
      let summary: string;
      if (previous) {
        const delta = renderEnvironmentStateDelta(
          previous,
          { fingerprint, context },
          { asOf: occurredAt, trigger: 'rebuild_watch', headline }
        );
        text = delta.text;
        summary = delta.changed ? `${headline} (${delta.summary})` : headline;
      } else {
        text = renderEnvironmentStateBlock(context, { asOf: occurredAt, trigger: 'rebuild_watch', headline });
        summary = headline;
      }

      await insertStateEvent({
        thread,
        uuid,
        text,
        metadata: {
          kind: ENVIRONMENT_STATE_METADATA_KIND,
          trigger: 'rebuild_watch',
          occurredAt,
          summary,
          fingerprint: JSON.stringify(fingerprint),
          ...(session.buildUuid ? { buildUuid: session.buildUuid } : {}),
          ...(commitUrl ? { commitUrl } : {}),
        },
      });
    } catch (error) {
      logger().warn({ error, uuidSeed }, `EnvState: watch state event failed seed=${uuidSeed}`);
    }
  }

  /** Current full state block for the get_environment_status tool. Pure read — the tool result is the record. */
  static async renderCurrentState({
    sessionDbId,
    namespace,
    buildUuid,
  }: {
    sessionDbId: number;
    namespace?: string | null;
    buildUuid?: string | null;
  }): Promise<string> {
    const context = await resolveAgentSessionPromptContext({
      sessionDbId,
      namespace: namespace || null,
      buildUuid: buildUuid || null,
      includeTriage: true,
    });
    return renderEnvironmentStateBlock(context, { asOf: new Date().toISOString(), trigger: 'run_start' });
  }
}
