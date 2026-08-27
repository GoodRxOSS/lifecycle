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

import type { AgentRuntimeToolMetadata } from 'server/services/agent/toolMetadata';
import type { AgentApprovalPolicy } from 'server/services/agent/types';
import { buildWorkspaceCorePromptLines } from '../prompt';

const allowPolicy = { defaultMode: 'allow', rules: {} } as AgentApprovalPolicy;

function runtimeMetadata(toolKey: string, serverSlug?: string): AgentRuntimeToolMetadata {
  return {
    toolKey,
    serverSlug,
    catalogCapabilityId: 'workspace_files',
    capabilityKey: 'read',
    approvalMode: 'allow',
  };
}

describe('buildWorkspaceCorePromptLines', () => {
  it('describes every equipped category and its required execution guidance', () => {
    const lines = buildWorkspaceCorePromptLines({ approvalPolicy: allowPolicy });

    expect(lines).toHaveLength(9);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('inspect files, search code, and read git state: mcp__workspace_core__read_file'),
        expect.stringContaining('edit workspace files: mcp__workspace_core__apply_patch'),
        expect.stringContaining('run commands and manage async operations: mcp__workspace_core__exec'),
        expect.stringContaining('run long-lived services such as dev servers: mcp__workspace_core__start_service'),
        expect.stringContaining('publish and verify HTTP previews: mcp__workspace_core__publish_http'),
        '- use workspace_core.exec for bounded commands, tests, and installs',
        expect.stringContaining('start dev servers and anything that must keep running'),
        expect.stringContaining('when serving an HTTP preview from the workspace'),
      ])
    );
  });

  it('omits workspace guidance when runtime discovery found only unrelated tools', () => {
    expect(
      buildWorkspaceCorePromptLines({
        approvalPolicy: allowPolicy,
        runtimeToolMetadata: [runtimeMetadata('mcp__github__get_issue', 'github')],
      })
    ).toEqual([]);
  });

  it('recognizes both canonical server metadata and legacy workspace-core key prefixes', () => {
    const lines = buildWorkspaceCorePromptLines({
      approvalPolicy: allowPolicy,
      runtimeToolMetadata: [
        runtimeMetadata('mcp__workspace_core__read_file', 'workspace_core'),
        runtimeMetadata('mcp__workspace_core__exec'),
      ],
    });

    expect(lines).toEqual([
      '- inspect files, search code, and read git state: mcp__workspace_core__read_file',
      '- run commands and manage async operations: mcp__workspace_core__exec',
      '- do not claim a tool is unavailable unless it is not equipped here or a real tool call fails',
      '- use workspace_core.exec for bounded commands, tests, and installs',
    ]);
  });

  it('applies an explicit deny rule while retaining other discovered tools', () => {
    const lines = buildWorkspaceCorePromptLines({
      approvalPolicy: allowPolicy,
      toolRules: [{ toolKey: 'mcp__workspace_core__read_file', mode: 'deny' }],
      runtimeToolMetadata: [
        runtimeMetadata('mcp__workspace_core__read_file', 'workspace_core'),
        runtimeMetadata('mcp__workspace_core__write_file', 'workspace_core'),
      ],
    });

    expect(lines).toEqual([
      '- edit workspace files: mcp__workspace_core__write_file',
      '- do not claim a tool is unavailable unless it is not equipped here or a real tool call fails',
    ]);
  });

  it('returns no guidance when workspace metadata contains no registered tool key', () => {
    expect(
      buildWorkspaceCorePromptLines({
        approvalPolicy: allowPolicy,
        runtimeToolMetadata: [runtimeMetadata('mcp__workspace_core__removed_tool', 'workspace_core')],
      })
    ).toEqual([]);
  });
});
