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

import GlobalConfigService from 'server/services/globalConfig';
import { getLogger } from 'server/lib/logger';
import type { WorkspaceBackendId } from './types';

const VERIFICATION_CONFIG_KEY = 'workspaceBackendVerifications';

export interface BackendVerification {
  ok: boolean;
  at: string;
  /** 'connection' = credential probe; 'deep' = booted a real test sandbox. */
  kind: 'connection' | 'deep';
}

type VerificationMap = Partial<Record<WorkspaceBackendId, BackendVerification>>;

function isVerification(value: unknown): value is BackendVerification {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BackendVerification).ok === 'boolean' &&
    typeof (value as BackendVerification).at === 'string'
  );
}

export async function getBackendVerifications(): Promise<VerificationMap> {
  let raw: unknown;
  try {
    raw = await GlobalConfigService.getInstance().getConfig(VERIFICATION_CONFIG_KEY);
  } catch {
    // The catalog must render even if the config store is unavailable.
    return {};
  }
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: VerificationMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isVerification(value)) {
      out[id as WorkspaceBackendId] = value;
    }
  }
  return out;
}

// Best-effort: a recording failure must never fail the check that triggered it.
export async function recordBackendVerification(
  id: WorkspaceBackendId,
  verification: Omit<BackendVerification, 'at'>
): Promise<void> {
  try {
    const current = await getBackendVerifications();
    await GlobalConfigService.getInstance().setConfig(VERIFICATION_CONFIG_KEY, {
      ...current,
      [id]: { ...verification, at: new Date().toISOString() },
    });
  } catch (error) {
    getLogger().warn({ error, id }, 'Workspace verification state: record failed');
  }
}

// A verification describes the config it ran against; when that config changes the
// record is meaningless (a stale failure would shadow a fixed setup, and vice versa).
export async function clearBackendVerifications(ids: WorkspaceBackendId[]): Promise<void> {
  if (!ids.length) {
    return;
  }
  try {
    const current = await getBackendVerifications();
    const next = { ...current };
    let changed = false;
    for (const id of ids) {
      if (next[id]) {
        delete next[id];
        changed = true;
      }
    }
    if (changed) {
      await GlobalConfigService.getInstance().setConfig(VERIFICATION_CONFIG_KEY, next);
    }
  } catch (error) {
    getLogger().warn({ error, ids }, 'Workspace verification state: clear failed');
  }
}
