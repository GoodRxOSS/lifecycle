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

import AgentToolExecution from 'server/models/AgentToolExecution';
import { BuildStatus } from 'shared/constants';
import type { AgentUIMessage } from './types';

const UPDATE_FILE_TOOL_KEY = 'mcp__lifecycle__update_file';
// Tool executions persist the unprefixed name; UI message parts use the prefixed key.
const UPDATE_FILE_TOOL_NAMES = ['update_file', UPDATE_FILE_TOOL_KEY];

export const IN_PROGRESS_BUILD_STATUSES = new Set<string>([
  BuildStatus.PENDING,
  BuildStatus.QUEUED,
  BuildStatus.BUILDING,
  BuildStatus.BUILT,
  BuildStatus.DEPLOYING,
]);

export type DebugRepairCommitObservation = {
  commitUrl?: string | null;
  commitSha?: string | null;
  changed?: boolean | null;
  commitCreated?: boolean | null;
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
