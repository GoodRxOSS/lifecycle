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

import { randomBytes } from 'crypto';
import type { Job } from 'bullmq';
import QueueManager from 'server/lib/queueManager';
import RedisClient from 'server/lib/redisClient';
import { getLogger, extractContextForQueue } from 'server/lib/logger';
import Build from 'server/models/Build';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import { BuildStatus } from 'shared/constants';
import AgentMessageStore from './MessageStore';
import { formatStatus, summarizeFailingDeploys, IN_PROGRESS_BUILD_STATUSES } from './debugRepairObservation';
import type { AgentUIMessage } from './types';

export const AGENT_ENV_WATCH_QUEUE_NAME = 'agent_env_watch';
// Must match the kind MessageStore serves alongside 'agent_switch' system rows.
// randomBytes-based v4 uuid: typed in every @types/node version across both tsconfigs.
function uuidV4(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const ENVIRONMENT_UPDATE_METADATA_KIND = 'environment_update';

const POLL_INTERVAL_MS = 15_000;
const WATCH_TIMEOUT_MS = 30 * 60_000;
const MAX_POLLS = 130;
// Outlives the watch timeout so an orphaned marker never blocks watches forever.
const MARKER_TTL_SECONDS = 35 * 60;
const MAX_BLOCKER_TEXT_CHARS = 600;

const TERMINAL_FAILURE_BUILD_STATUSES = new Set<string>([
  BuildStatus.ERROR,
  BuildStatus.CONFIG_ERROR,
  BuildStatus.TORN_DOWN,
]);

const logger = () => getLogger();

export type EnvironmentWatchReason = 'repair_commit' | 'trigger_redeploy';

export type EnvironmentWatchOutcome = 'success' | 'failure' | 'pending';

export type AgentEnvironmentWatchJob = {
  watchId: string;
  buildUuid: string;
  buildId?: number | null;
  threadUuid: string;
  sessionUuid?: string | null;
  reason: EnvironmentWatchReason;
  baselineStatus?: string | null;
  baselineFingerprint?: string | null;
  sawActivity?: boolean;
  pollCount: number;
  deadlineAt: string;
  correlationId?: string;
  sender?: string;
  _ddTraceContext?: Record<string, string>;
};

export type ScheduleEnvironmentWatchInput = {
  buildUuid: string;
  buildId?: number | null;
  // When omitted (e.g. trigger_redeploy tool only knows the build), the most
  // recently active non-ended agent session for the build resolves the thread.
  threadUuid?: string | null;
  sessionUuid?: string | null;
  reason: EnvironmentWatchReason;
  baselineStatus?: string | null;
};

export type ScheduleEnvironmentWatchResult = {
  scheduled: boolean;
  threadUuid?: string;
  reason?: 'missing_build' | 'thread_unresolved' | 'duplicate' | 'error';
};

export function environmentWatchDedupeKey(buildUuid: string, threadUuid: string): string {
  return `env-watch:${buildUuid}:${threadUuid}`;
}

// A terminal status only counts once rebuild activity was observed, so a stale
// pre-rebuild terminal row is not reported as the outcome. `forceTerminal`
// (deadline reached) reports the current terminal status regardless.
export function classifyEnvironmentWatchOutcome({
  status,
  sawActivity,
  forceTerminal = false,
}: {
  status: string;
  sawActivity: boolean;
  forceTerminal?: boolean;
}): EnvironmentWatchOutcome {
  const reportable = sawActivity || forceTerminal;
  if (status === BuildStatus.DEPLOYED) {
    return reportable ? 'success' : 'pending';
  }

  if (TERMINAL_FAILURE_BUILD_STATUSES.has(status)) {
    return reportable ? 'failure' : 'pending';
  }

  return 'pending';
}

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

export function buildEnvironmentWatchMessageText({
  outcome,
  status,
  statusMessage,
  deploys,
}: {
  outcome: 'success' | 'failure' | 'timeout';
  status?: string | null;
  statusMessage?: string | null;
  deploys?: any[];
}): string {
  if (outcome === 'success') {
    return 'Environment rebuilt successfully after the repair: status=deployed.';
  }

  if (outcome === 'timeout') {
    return `The rebuild has not reached a terminal state after 30 minutes (status=${status || 'unknown'}).`;
  }

  const failing = summarizeFailingDeploys(deploys || []);
  const blocker = failing
    ? ` Current blocker: ${truncateText(failing, MAX_BLOCKER_TEXT_CHARS)}.`
    : ' Check the latest deploy details for the current blocker.';
  return `The rebuild after the repair finished with ${formatStatus(status, statusMessage)}.${blocker}`;
}

function watchFingerprint(build: Build): string {
  return JSON.stringify({
    status: build.status || null,
    statusMessage: build.statusMessage || null,
    updatedAt: build.updatedAt || null,
  });
}

async function loadBuildForWatch(buildUuid: string): Promise<Build | null> {
  return (await Build.query().findOne({ uuid: buildUuid }).withGraphFetched('[deploys.[deployable, service]]')) || null;
}

async function resolveWatchTarget(
  buildUuid: string
): Promise<{ threadUuid: string; sessionUuid: string | null } | null> {
  const session = await AgentSession.query()
    .where({ buildUuid })
    .whereNot({ status: 'archived' })
    .orderBy('lastActivity', 'desc')
    .first();
  if (!session) {
    return null;
  }

  const thread = session.defaultThreadId
    ? await AgentThread.query().findById(session.defaultThreadId)
    : await AgentThread.query()
        .where({ sessionId: session.id })
        .orderBy('isDefault', 'desc')
        .orderBy('id', 'desc')
        .first();
  return thread ? { threadUuid: thread.uuid, sessionUuid: session.uuid } : null;
}

export default class EnvironmentWatchService {
  private static queue = QueueManager.getInstance().registerQueue(AGENT_ENV_WATCH_QUEUE_NAME, {
    connection: RedisClient.getInstance().getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });

  // Never throws: call sites run inside run finalization / tool execution.
  static async scheduleEnvironmentWatch(input: ScheduleEnvironmentWatchInput): Promise<ScheduleEnvironmentWatchResult> {
    try {
      const buildUuid = input.buildUuid?.trim();
      if (!buildUuid) {
        return { scheduled: false, reason: 'missing_build' };
      }

      const target = input.threadUuid
        ? { threadUuid: input.threadUuid, sessionUuid: input.sessionUuid || null }
        : await resolveWatchTarget(buildUuid);
      if (!target) {
        logger().info(`EnvWatch: no thread resolved buildUuid=${buildUuid} reason=${input.reason}`);
        return { scheduled: false, reason: 'thread_unresolved' };
      }

      const watchId = uuidV4();
      const markerKey = environmentWatchDedupeKey(buildUuid, target.threadUuid);
      const acquired = await RedisClient.getInstance()
        .getConnection()
        .set(markerKey, watchId, 'EX', MARKER_TTL_SECONDS, 'NX');
      if (!acquired) {
        logger().info(`EnvWatch: duplicate watch skipped buildUuid=${buildUuid} threadUuid=${target.threadUuid}`);
        return { scheduled: false, reason: 'duplicate', threadUuid: target.threadUuid };
      }

      const payload: AgentEnvironmentWatchJob = {
        watchId,
        buildUuid,
        buildId: input.buildId ?? null,
        threadUuid: target.threadUuid,
        sessionUuid: target.sessionUuid,
        reason: input.reason,
        baselineStatus: input.baselineStatus ?? null,
        baselineFingerprint: null,
        sawActivity: false,
        pollCount: 0,
        deadlineAt: new Date(Date.now() + WATCH_TIMEOUT_MS).toISOString(),
        ...extractContextForQueue(),
      };
      await this.queue.add('environment-watch', payload, {
        jobId: `env-watch:${watchId}:0`,
        delay: POLL_INTERVAL_MS,
      });
      logger().info(
        `EnvWatch: scheduled buildUuid=${buildUuid} threadUuid=${target.threadUuid} reason=${input.reason} watchId=${watchId}`
      );
      return { scheduled: true, threadUuid: target.threadUuid };
    } catch (error) {
      logger().warn({ error }, `EnvWatch: schedule failed buildUuid=${input.buildUuid} reason=${input.reason}`);
      return { scheduled: false, reason: 'error' };
    }
  }

  static async processWatchJob(job: Job<AgentEnvironmentWatchJob>): Promise<void> {
    const data = job.data;
    if (!data?.watchId || !data.buildUuid || !data.threadUuid) {
      logger().warn(`EnvWatch: invalid job payload jobId=${String(job.id)}`);
      return;
    }

    try {
      const build = await loadBuildForWatch(data.buildUuid);
      if (!build) {
        logger().info(`EnvWatch: build missing buildUuid=${data.buildUuid} threadUuid=${data.threadUuid}`);
        await this.releaseMarker(data);
        return;
      }

      const status = String(build.status || '');
      const fingerprint = watchFingerprint(build);
      const sawActivity = Boolean(
        data.sawActivity ||
          IN_PROGRESS_BUILD_STATUSES.has(status) ||
          (data.baselineStatus && status !== data.baselineStatus) ||
          (data.baselineFingerprint && fingerprint !== data.baselineFingerprint)
      );
      const expired = Date.now() >= Date.parse(data.deadlineAt) || data.pollCount >= MAX_POLLS;
      const outcome = classifyEnvironmentWatchOutcome({ status, sawActivity, forceTerminal: expired });

      if (outcome === 'pending' && !expired) {
        await this.enqueueNextPoll({
          ...data,
          pollCount: data.pollCount + 1,
          baselineFingerprint: data.baselineFingerprint || fingerprint,
          sawActivity,
        });
        return;
      }

      const messageOutcome = outcome === 'pending' ? 'timeout' : outcome;
      const text = buildEnvironmentWatchMessageText({
        outcome: messageOutcome,
        status: build.status,
        statusMessage: build.statusMessage,
        deploys: build.deploys || [],
      });
      await this.appendEnvironmentUpdateMessage(data, messageOutcome, status, text);
      await this.releaseMarker(data);
      logger().info(
        `EnvWatch: finished buildUuid=${data.buildUuid} threadUuid=${data.threadUuid} outcome=${messageOutcome} status=${status} polls=${data.pollCount}`
      );
    } catch (error) {
      logger().warn(
        { error },
        `EnvWatch: poll failed buildUuid=${data.buildUuid} threadUuid=${data.threadUuid} pollCount=${data.pollCount}`
      );
      const withinBudget = data.pollCount < MAX_POLLS && Date.now() < Date.parse(data.deadlineAt);
      if (!withinBudget) {
        await this.releaseMarker(data);
        return;
      }

      await this.enqueueNextPoll({ ...data, pollCount: data.pollCount + 1 }).catch((enqueueError) => {
        logger().warn({ error: enqueueError }, `EnvWatch: re-enqueue failed buildUuid=${data.buildUuid}`);
      });
    }
  }

  private static async enqueueNextPoll(data: AgentEnvironmentWatchJob): Promise<void> {
    await this.queue.add('environment-watch', data, {
      jobId: `env-watch:${data.watchId}:${data.pollCount}`,
      delay: POLL_INTERVAL_MS,
    });
  }

  private static async appendEnvironmentUpdateMessage(
    data: AgentEnvironmentWatchJob,
    outcome: 'success' | 'failure' | 'timeout',
    status: string,
    text: string
  ): Promise<void> {
    const thread = await AgentThread.query().findOne({ uuid: data.threadUuid });
    if (!thread) {
      logger().info(`EnvWatch: thread missing threadUuid=${data.threadUuid} buildUuid=${data.buildUuid}`);
      return;
    }

    const metadata = {
      kind: ENVIRONMENT_UPDATE_METADATA_KIND,
      threadId: data.threadUuid,
      ...(data.sessionUuid ? { sessionId: data.sessionUuid } : {}),
      buildUuid: data.buildUuid,
      reason: data.reason,
      outcome,
      status,
      occurredAt: new Date().toISOString(),
    };
    // watchId doubles as the message uuid so a re-processed job upserts instead of duplicating.
    const message: AgentUIMessage = {
      id: data.watchId,
      role: 'system',
      metadata,
      parts: [{ type: 'text', text }],
    };
    await AgentMessageStore.upsertCanonicalUiMessagesForThread({ id: thread.id }, [message]);
  }

  private static async releaseMarker(data: AgentEnvironmentWatchJob): Promise<void> {
    try {
      await RedisClient.getInstance().getConnection().del(environmentWatchDedupeKey(data.buildUuid, data.threadUuid));
    } catch (error) {
      logger().warn({ error }, `EnvWatch: marker release failed buildUuid=${data.buildUuid}`);
    }
  }
}

export const scheduleEnvironmentWatch = EnvironmentWatchService.scheduleEnvironmentWatch.bind(EnvironmentWatchService);
