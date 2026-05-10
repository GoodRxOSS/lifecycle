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
      '- inspect files, services, and git state: mcp__sandbox__workspace_read_file, mcp__sandbox__workspace_glob, mcp__sandbox__workspace_grep, mcp__sandbox__workspace_exec, mcp__sandbox__session_get_workspace_state, mcp__sandbox__session_list_ports, mcp__sandbox__session_list_processes, mcp__sandbox__session_get_service_status, mcp__sandbox__git_status, mcp__sandbox__git_diff',
      '- change workspace files directly: mcp__sandbox__workspace_write_file, mcp__sandbox__workspace_edit_file',
      '- run verification, mutating, or networked shell commands that are not direct file edits: mcp__sandbox__workspace_exec_mutation',
      '- manage local git changes: mcp__sandbox__git_add, mcp__sandbox__git_commit, mcp__sandbox__git_branch',
      '- discover and learn equipped skills: mcp__sandbox__skills_list, mcp__sandbox__skills_learn',
      '- do not claim a tool is unavailable unless it is not equipped here or a real tool call fails',
      '- local commits do not update GitHub, PR heads, or Lifecycle builds; use the shell mutation tool for git push or gh and only claim remote/build updates after observing them',
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
      '- inspect files, services, and git state: mcp__sandbox__workspace_read_file, mcp__sandbox__workspace_glob, mcp__sandbox__workspace_grep, mcp__sandbox__workspace_exec, mcp__sandbox__session_get_workspace_state, mcp__sandbox__session_list_ports, mcp__sandbox__session_list_processes, mcp__sandbox__session_get_service_status, mcp__sandbox__git_status, mcp__sandbox__git_diff',
      '- manage local git changes: mcp__sandbox__git_add, mcp__sandbox__git_commit, mcp__sandbox__git_branch',
      '- do not claim a tool is unavailable unless it is not equipped here or a real tool call fails',
      '- local commits do not update GitHub, PR heads, or Lifecycle builds; use the shell mutation tool for git push or gh and only claim remote/build updates after observing them',
    ]);
  });

  it('makes local commit and remote publish semantics explicit', () => {
    const entries = listSessionWorkspaceToolCatalog();
    const mutationTool = entries.find((entry) => entry.toolName === 'workspace.exec_mutation');
    const commitTool = entries.find((entry) => entry.toolName === 'git.commit');

    expect(mutationTool?.description).toContain('verification commands such as tests and syntax checks');
    expect(mutationTool?.description).toContain('remote verification commands such as git ls-remote');
    expect(mutationTool?.description).toContain('git pushes');
    expect(commitTool?.description).toContain('local-only commit');
    expect(commitTool?.description).toContain('does not push');
    expect(commitTool?.description).toContain('does not trigger Lifecycle rebuilds');
  });

  it('keeps explicitly allowed tools in the prompt summary even when the family is denied', () => {
    const lines = buildSessionWorkspacePromptLines({
      approvalPolicy: {
        ...DEFAULT_AGENT_APPROVAL_POLICY,
        rules: {
          ...DEFAULT_AGENT_APPROVAL_POLICY.rules,
          read: 'deny',
        },
      },
      toolRules: [
        {
          toolKey: 'mcp__sandbox__workspace_read_file',
          mode: 'allow',
        },
      ],
      includeSkills: false,
    });

    expect(lines.join('\n')).toContain('mcp__sandbox__workspace_read_file');
    expect(lines.join('\n')).not.toContain('mcp__sandbox__workspace_glob');
  });
});
