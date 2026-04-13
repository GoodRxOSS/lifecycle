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

import type { AgentSessionSkillPlan } from './skillPlan';

export const SESSION_SKILLS_BOOTSTRAP_SCRIPT = '/opt/lifecycle-workspace-gateway/skills-bootstrap.mjs';

function escapeDoubleQuotedShell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

export function generateSkillBootstrapCommand(
  skillPlan: AgentSessionSkillPlan | null | undefined,
  opts?: {
    useGitHubToken?: boolean;
  }
): string {
  const payload = Buffer.from(
    JSON.stringify(
      skillPlan || {
        version: 1,
        skills: [],
      }
    ),
    'utf8'
  ).toString('base64');
  const lines = ['set -e'];

  if (opts?.useGitHubToken) {
    lines.push(
      'if [ -n "${GITHUB_TOKEN:-}" ]; then',
      '  git config --global credential.helper \'!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f\'',
      'fi'
    );
  }

  lines.push(
    `node "${escapeDoubleQuotedShell(SESSION_SKILLS_BOOTSTRAP_SCRIPT)}" "${escapeDoubleQuotedShell(payload)}"`
  );

  return lines.join('\n');
}
