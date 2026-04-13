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

import { DEFAULT_AGENT_APPROVAL_POLICY } from '../types';
import {
  buildSessionWorkspacePromptLines,
  listAdminVisibleSessionWorkspaceToolCatalog,
  listSessionWorkspaceToolCatalog,
} from '../sandboxToolCatalog';

describe('sandboxToolCatalog', () => {
  it('covers the built-in session workspace tools that are surfaced in admin and runtime', () => {
    expect(listSessionWorkspaceToolCatalog().map((entry) => entry.toolName)).toEqual([
      'skills.list',
      'skills.learn',
      'workspace.read_file',
      'workspace.glob',
      'workspace.grep',
      'workspace.exec',
      'session.get_workspace_state',
      'session.list_ports',
      'session.list_processes',
      'session.get_service_status',
      'git.status',
      'git.diff',
      'workspace.write_file',
      'workspace.edit_file',
      'workspace.exec_mutation',
      'git.add',
      'git.commit',
      'git.branch',
    ]);
  });

  it('hides system session helpers and skills from the admin-visible inventory', () => {
    expect(listAdminVisibleSessionWorkspaceToolCatalog().map((entry) => entry.toolName)).toEqual([
      'workspace.read_file',
      'workspace.glob',
      'workspace.grep',
      'workspace.exec',
      'git.status',
      'git.diff',
      'workspace.write_file',
      'workspace.edit_file',
      'workspace.exec_mutation',
      'git.add',
      'git.commit',
      'git.branch',
    ]);
  });

  it('builds a concise prompt summary for the currently available tool families', () => {
    expect(
      buildSessionWorkspacePromptLines({
        approvalPolicy: DEFAULT_AGENT_APPROVAL_POLICY,
        includeSkills: true,
      })
    ).toEqual([
      '- inspect files, services, and git state: workspace.read_file, workspace.glob, workspace.grep, workspace.exec, session.get_workspace_state, session.list_ports, session.list_processes, session.get_service_status, git.status, git.diff',
      '- change workspace files directly: workspace.write_file, workspace.edit_file',
      '- run mutating or networked shell commands: workspace.exec_mutation',
      '- manage git changes: git.add, git.commit, git.branch',
      '- discover and learn equipped skills: skills.list, skills.learn',
      '- do not claim a tool is unavailable unless it is not equipped here or a real tool call fails',
    ]);
  });

  it('omits denied tool families from the prompt summary', () => {
    expect(
      buildSessionWorkspacePromptLines({
        approvalPolicy: {
          ...DEFAULT_AGENT_APPROVAL_POLICY,
          rules: {
            ...DEFAULT_AGENT_APPROVAL_POLICY.rules,
            workspace_write: 'deny',
            shell_exec: 'deny',
          },
        },
        toolRules: [
          {
            toolKey: 'mcp__sandbox__skills_list',
            mode: 'deny',
          },
          {
            toolKey: 'mcp__sandbox__skills_learn',
            mode: 'deny',
          },
        ],
        includeSkills: true,
      })
    ).toEqual([
      '- inspect files, services, and git state: workspace.read_file, workspace.glob, workspace.grep, workspace.exec, session.get_workspace_state, session.list_ports, session.list_processes, session.get_service_status, git.status, git.diff',
      '- manage git changes: git.add, git.commit, git.branch',
      '- do not claim a tool is unavailable unless it is not equipped here or a real tool call fails',
    ]);
  });
});
