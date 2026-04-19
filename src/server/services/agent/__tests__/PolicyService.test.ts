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

import AgentPolicyService from '../PolicyService';

describe('AgentPolicyService', () => {
  it('keeps read-only sandbox tools in the read capability', () => {
    expect(
      AgentPolicyService.capabilityForSessionWorkspaceTool('workspace.read_file', {
        readOnlyHint: true,
      })
    ).toBe('read');
  });

  it('keeps session git helpers in the git write capability', () => {
    expect(AgentPolicyService.capabilityForSessionWorkspaceTool('git.branch')).toBe('git_write');
  });

  it('maps read-only external MCP tools to external_mcp_read', () => {
    expect(
      AgentPolicyService.capabilityForExternalMcpTool('getJiraIssue', {
        readOnlyHint: true,
      })
    ).toBe('external_mcp_read');
  });

  it('maps mutating external MCP tools to external_mcp_write without workspace heuristics', () => {
    expect(AgentPolicyService.capabilityForExternalMcpTool('editJiraIssue')).toBe('external_mcp_write');
  });
});
