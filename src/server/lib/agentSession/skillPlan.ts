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

import type { DevConfig, AgentSessionSkillRef } from 'server/models/yaml/YamlService';
import { repoNameFromRepoUrl } from './workspace';

export interface AgentSessionSkillPlanEntry {
  repo: string;
  repoUrl: string;
  branch: string;
  path: string;
  source: 'environment' | 'service';
  serviceName?: string | null;
}

export interface AgentSessionSkillPlan {
  version: 1;
  skills: AgentSessionSkillPlanEntry[];
}

type AgentSessionSkillPlanServiceInput = {
  name: string;
  devConfig: Pick<DevConfig, 'agentSession'>;
};

export const EMPTY_AGENT_SESSION_SKILL_PLAN: AgentSessionSkillPlan = {
  version: 1,
  skills: [],
};

function normalizeRepoRef(repoRef: string): { repo: string; repoUrl: string } {
  const trimmed = repoRef.trim();
  if (!trimmed) {
    throw new Error('Skill repo is required');
  }

  const repo = repoNameFromRepoUrl(trimmed) || trimmed.replace(/\.git$/, '');
  if (!repo.includes('/')) {
    throw new Error(`Invalid skill repo: ${repoRef}`);
  }

  return {
    repo,
    repoUrl:
      trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://github.com/${repo}.git`,
  };
}

function normalizeSkillPath(skillPath: string): string {
  const normalized = skillPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized) {
    throw new Error('Skill path is required');
  }

  return normalized;
}

function buildDedupKey(entry: AgentSessionSkillPlanEntry): string {
  return `${entry.repo.trim().toLowerCase()}::${entry.branch.trim()}::${entry.path.trim()}`;
}

function addEntries(
  entries: AgentSessionSkillPlanEntry[],
  seenKeys: Set<string>,
  nextEntries: AgentSessionSkillPlanEntry[]
) {
  for (const entry of nextEntries) {
    const key = buildDedupKey(entry);
    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    entries.push(entry);
  }
}

function normalizeSkillRef(
  skillRef: AgentSessionSkillRef,
  source: AgentSessionSkillPlanEntry['source'],
  serviceName?: string | null
): AgentSessionSkillPlanEntry {
  const { repo, repoUrl } = normalizeRepoRef(skillRef.repo);

  return {
    repo,
    repoUrl,
    branch: skillRef.branch.trim(),
    path: normalizeSkillPath(skillRef.path),
    source,
    ...(serviceName ? { serviceName } : {}),
  };
}

export function resolveAgentSessionSkillPlan(opts: {
  environmentSkillRefs?: ReadonlyArray<AgentSessionSkillRef> | null;
  services?: ReadonlyArray<AgentSessionSkillPlanServiceInput> | null;
  basePlan?: AgentSessionSkillPlan | null;
}): AgentSessionSkillPlan {
  const entries: AgentSessionSkillPlanEntry[] = [];
  const seenKeys = new Set<string>();

  addEntries(entries, seenKeys, opts.basePlan?.skills || []);

  addEntries(
    entries,
    seenKeys,
    (opts.environmentSkillRefs || []).map((skillRef) => normalizeSkillRef(skillRef, 'environment'))
  );

  for (const service of opts.services || []) {
    addEntries(
      entries,
      seenKeys,
      (service.devConfig.agentSession?.skills || []).map((skillRef) =>
        normalizeSkillRef(skillRef, 'service', service.name)
      )
    );
  }

  return {
    version: 1,
    skills: entries,
  };
}
