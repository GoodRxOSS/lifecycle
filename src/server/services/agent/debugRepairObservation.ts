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

import type AgentSession from 'server/models/AgentSession';
import AgentToolExecution from 'server/models/AgentToolExecution';
import Build from 'server/models/Build';
import { BuildStatus, DeployStatus } from 'shared/constants';
import type { AgentRunPlanSnapshotV1 } from './runPlanTypes';
import type { AgentUIMessage } from './types';

const UPDATE_FILE_TOOL_KEY = 'mcp__lifecycle__update_file';
// Tool executions persist the unprefixed name; UI message parts use the prefixed key.
const UPDATE_FILE_TOOL_NAMES = ['update_file', UPDATE_FILE_TOOL_KEY];
const FAILURE_DEPLOY_STATUSES = new Set<string>([
  DeployStatus.ERROR,
  DeployStatus.BUILD_FAILED,
  DeployStatus.DEPLOY_FAILED,
]);
export const IN_PROGRESS_BUILD_STATUSES = new Set<string>([
  BuildStatus.PENDING,
  BuildStatus.QUEUED,
  BuildStatus.BUILDING,
  BuildStatus.BUILT,
  BuildStatus.DEPLOYING,
]);
export const REPAIR_OBSERVATION_NO_REBUILD_TEXT =
  'Fresh Lifecycle state: no repair commit was created because the target file already matched the requested content, so no webhook rebuild should be expected from this repair action.';
const REPAIR_OBSERVATION_DEPLOYED_TEXT =
  'Fresh Lifecycle state: Lifecycle picked up the repair commit and the environment is deployed.';
const REPAIR_OBSERVATION_TERMINAL_MARKER = 'the environment is still terminal ';
// 30s covers typical webhook→queue latency; the poll exits early once the rebuild is observed.
const DEFAULT_REPAIR_OBSERVATION_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_REPAIR_OBSERVATION_POLL_INTERVAL_MS = 2_000;

export type DebugRepairCommitObservation = {
  commitUrl?: string | null;
  commitSha?: string | null;
  changed?: boolean | null;
  commitCreated?: boolean | null;
};

export type DebugRepairObservationPollOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectRecordsAndStrings(
  value: unknown,
  output: { records: Record<string, unknown>[]; strings: string[] },
  depth = 0
) {
  if (depth > 6 || value == null) {
    return;
  }

  if (typeof value === 'string') {
    output.strings.push(value);
    const parsed = parseJson(value);
    if (parsed !== null) {
      collectRecordsAndStrings(parsed, output, depth + 1);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectRecordsAndStrings(item, output, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  output.records.push(value);
  for (const child of Object.values(value)) {
    collectRecordsAndStrings(child, output, depth + 1);
  }
}

function readFirstString(records: Record<string, unknown>[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }

  return null;
}

function readFirstBoolean(records: Record<string, unknown>[], keys: string[]): boolean | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'boolean') {
        return value;
      }
    }
  }

  return null;
}

function extractCommitUrlFromText(strings: string[]): string | null {
  for (const value of strings) {
    const match = value.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/[0-9a-f]{40}\b/i);
    if (match) {
      return match[0];
    }
  }

  return null;
}

function extractCommitShaFromUrl(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/\/commit\/([0-9a-f]{40})/i);
  return match?.[1] || null;
}

function extractCommitObservationFromValue(value: unknown): DebugRepairCommitObservation | null {
  const collected = { records: [] as Record<string, unknown>[], strings: [] as string[] };
  collectRecordsAndStrings(value, collected);

  const commitUrl =
    readFirstString(collected.records, ['commit_url', 'commitUrl']) || extractCommitUrlFromText(collected.strings);
  const commitSha =
    readFirstString(collected.records, ['commit_sha', 'commitSha', 'sha']) || extractCommitShaFromUrl(commitUrl);
  const changed = readFirstBoolean(collected.records, ['changed']);
  const commitCreated = readFirstBoolean(collected.records, ['commit_created', 'commitCreated']);

  if (commitUrl || commitSha || changed === false || commitCreated === false) {
    return {
      commitUrl,
      commitSha,
      changed,
      commitCreated,
    };
  }

  return null;
}

// AI SDK static tool parts are typed `tool-<name>` with no toolName property; dynamic-tool parts carry toolName.
function isUpdateFileToolPart(part: Record<string, unknown>): boolean {
  if (typeof part.toolName === 'string' && UPDATE_FILE_TOOL_NAMES.includes(part.toolName)) {
    return true;
  }

  return part.type === `tool-${UPDATE_FILE_TOOL_KEY}`;
}

export function extractDebugRepairCommitObservation(messages: AgentUIMessage[]): DebugRepairCommitObservation | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') {
      continue;
    }

    for (const rawPart of [...message.parts].reverse()) {
      const part = rawPart as unknown as Record<string, unknown>;
      if (!isRecord(part) || !isUpdateFileToolPart(part)) {
        continue;
      }

      const observation = extractCommitObservationFromValue([part.output, part]);
      if (observation) {
        return observation;
      }
    }
  }

  return null;
}

// Tool parts rarely survive into the final UIMessages (canonical persistence keeps only text/reasoning,
// and approval resumes rebuild history from persisted messages), so the run's recorded tool executions
// are the durable source for the repair commit.
export async function extractDebugRepairCommitFromToolExecutions(
  runId: number
): Promise<DebugRepairCommitObservation | null> {
  const executions = await AgentToolExecution.query()
    .where({ runId, status: 'completed' })
    .whereIn('toolName', UPDATE_FILE_TOOL_NAMES)
    .orderBy('id', 'desc');

  for (const execution of executions) {
    const observation = extractCommitObservationFromValue(execution.result);
    if (observation) {
      return observation;
    }
  }

  return null;
}

function matchesCommit(observed: string | null | undefined, commitSha: string | null | undefined): boolean {
  if (!observed || !commitSha) {
    return false;
  }

  const left = observed.toLowerCase();
  const right = commitSha.toLowerCase();
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export function formatStatus(status?: string | null, statusMessage?: string | null): string {
  const parts = [`status=${status || 'unknown'}`];
  if (statusMessage) {
    parts.push(`message=${statusMessage}`);
  }

  return parts.join(', ');
}

function deployName(deploy: any): string {
  return deploy.deployable?.name || deploy.service?.name || deploy.uuid || 'selected service';
}

export function summarizeFailingDeploys(deploys: any[]): string | null {
  const failing = deploys.filter((deploy) => FAILURE_DEPLOY_STATUSES.has(String(deploy.status)));
  if (!failing.length) {
    return null;
  }

  return failing
    .slice(0, 3)
    .map((deploy) => `${deployName(deploy)} ${formatStatus(deploy.status, deploy.statusMessage)}`)
    .join('; ');
}

function findSelectedDeploy(session: AgentSession, deploys: any[]): any | null {
  const selectedDeployUuid = session.selectedServices?.[0]?.deployUuid;
  if (!selectedDeployUuid) {
    return null;
  }

  return deploys.find((deploy) => deploy.uuid === selectedDeployUuid) || null;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function buildFingerprint(build: Build): string {
  return JSON.stringify({
    status: build.status || null,
    statusMessage: build.statusMessage || null,
    updatedAt: build.updatedAt || null,
    deploys: (build.deploys || []).map((deploy: any) => ({
      uuid: deploy.uuid || null,
      status: deploy.status || null,
      statusMessage: deploy.statusMessage || null,
      sha: deploy.sha || null,
    })),
  });
}

function isRepairCommitVisible(build: Build, commitSha?: string | null): boolean {
  const deploys = build.deploys || [];
  return (
    matchesCommit(build.pullRequest?.latestCommit, commitSha) ||
    matchesCommit(build.sha, commitSha) ||
    deploys.some((deploy: any) => matchesCommit(deploy.sha, commitSha))
  );
}

function hasFreshRepairActivity(initialBuild: Build, build: Build): boolean {
  const buildStatus = String(build.status || '');
  return (
    buildStatus === BuildStatus.DEPLOYED ||
    IN_PROGRESS_BUILD_STATUSES.has(buildStatus) ||
    buildFingerprint(initialBuild) !== buildFingerprint(build)
  );
}

async function loadBuild(buildUuid: string): Promise<Build | null> {
  return (
    (await Build.query()
      .findOne({ uuid: buildUuid })
      .withGraphFetched('[pullRequest, deploys.[deployable, service]]')) || null
  );
}

async function waitForObservedRepairState({
  buildUuid,
  repairCommit,
  poll,
}: {
  buildUuid: string;
  repairCommit: DebugRepairCommitObservation;
  poll?: DebugRepairObservationPollOptions;
}): Promise<{ build: Build | null; observed: boolean }> {
  let build = await loadBuild(buildUuid);
  if (!build) {
    return { build: null, observed: false };
  }

  const initialBuild = build;
  if (isRepairCommitVisible(build, repairCommit.commitSha) || hasFreshRepairActivity(initialBuild, build)) {
    return { build, observed: true };
  }

  const timeoutMs = poll?.timeoutMs ?? DEFAULT_REPAIR_OBSERVATION_POLL_TIMEOUT_MS;
  const intervalMs = poll?.intervalMs ?? DEFAULT_REPAIR_OBSERVATION_POLL_INTERVAL_MS;
  const sleepFn = poll?.sleep ?? sleep;
  const now = poll?.now ?? Date.now;
  const deadline = now() + timeoutMs;

  while (timeoutMs > 0 && now() < deadline) {
    await sleepFn(Math.min(intervalMs, Math.max(0, deadline - now())));
    const nextBuild = await loadBuild(buildUuid);
    if (!nextBuild) {
      return { build, observed: false };
    }

    build = nextBuild;
    if (isRepairCommitVisible(build, repairCommit.commitSha) || hasFreshRepairActivity(initialBuild, build)) {
      return { build, observed: true };
    }
  }

  return { build, observed: false };
}

// True when the observation text implies a webhook rebuild is still expected (used to schedule an environment watch).
export function repairObservationExpectsRebuild(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }

  return (
    text !== REPAIR_OBSERVATION_NO_REBUILD_TEXT &&
    !text.includes(REPAIR_OBSERVATION_DEPLOYED_TEXT) &&
    !text.includes(REPAIR_OBSERVATION_TERMINAL_MARKER)
  );
}

export async function buildDebugRepairObservationText({
  session,
  messages,
  runPlanSnapshot,
  runId,
  poll,
}: {
  session: AgentSession;
  messages: AgentUIMessage[];
  runPlanSnapshot?: AgentRunPlanSnapshotV1 | null;
  runId?: number | null;
  poll?: DebugRepairObservationPollOptions;
}): Promise<string | null> {
  if (
    runPlanSnapshot?.agent.sourceKind !== 'build_context_chat' ||
    runPlanSnapshot.debug?.resolvedIntent !== 'repair'
  ) {
    return null;
  }

  let repairCommit = extractDebugRepairCommitObservation(messages);
  if (!repairCommit && typeof runId === 'number') {
    repairCommit = await extractDebugRepairCommitFromToolExecutions(runId);
  }
  if (!repairCommit) {
    return null;
  }

  if (repairCommit.changed === false || repairCommit.commitCreated === false) {
    return REPAIR_OBSERVATION_NO_REBUILD_TEXT;
  }

  if (!session.buildUuid) {
    return repairCommit.commitUrl ? `Repair commit: ${repairCommit.commitUrl}` : null;
  }

  const { build, observed } = await waitForObservedRepairState({
    buildUuid: session.buildUuid,
    repairCommit,
    poll,
  });
  if (!build) {
    return repairCommit.commitUrl ? `Repair commit: ${repairCommit.commitUrl}` : null;
  }

  const deploys = build.deploys || [];
  const commitLine = repairCommit.commitUrl ? `Commit: ${repairCommit.commitUrl}. ` : '';
  const selectedDeploy = findSelectedDeploy(session, deploys);
  const selectedPriorStatus = session.selectedServices?.[0]?.deployStatus || null;
  const selectedMoveLine =
    selectedDeploy && selectedPriorStatus && selectedDeploy.status && selectedPriorStatus !== selectedDeploy.status
      ? `Selected service moved from status=${selectedPriorStatus} to ${formatStatus(
          selectedDeploy.status,
          selectedDeploy.statusMessage
        )}. `
      : '';
  const failingDeploys = summarizeFailingDeploys(deploys);
  const buildStatus = String(build.status || '');

  if (!observed) {
    return `${commitLine}Fresh Lifecycle state: the repair commit has not shown up on this environment yet, so a webhook rebuild has not been observed. Current environment ${formatStatus(
      build.status,
      build.statusMessage
    )}.`;
  }

  if (buildStatus === BuildStatus.DEPLOYED) {
    return `${commitLine}${REPAIR_OBSERVATION_DEPLOYED_TEXT}`;
  }

  if (buildStatus === BuildStatus.ERROR || buildStatus === BuildStatus.CONFIG_ERROR) {
    return `${commitLine}Fresh Lifecycle state: Lifecycle picked up the repair commit, but ${REPAIR_OBSERVATION_TERMINAL_MARKER}${formatStatus(
      build.status,
      build.statusMessage
    )}. ${selectedMoveLine}${
      failingDeploys
        ? `Current blocker: ${failingDeploys}.`
        : 'Check the latest deploy details for the current blocker.'
    }`;
  }

  if (IN_PROGRESS_BUILD_STATUSES.has(buildStatus)) {
    return `${commitLine}Fresh Lifecycle state: Lifecycle picked up the repair commit and the environment is still in progress with ${formatStatus(
      build.status,
      build.statusMessage
    )}.`;
  }

  return `${commitLine}Fresh Lifecycle state: Lifecycle picked up the repair commit. Current environment ${formatStatus(
    build.status,
    build.statusMessage
  )}.`;
}
