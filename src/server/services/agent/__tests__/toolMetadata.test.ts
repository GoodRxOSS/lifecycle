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

import { buildAgentRuntimeToolMetadata, isApprovalGatedWriteRuntimeTool, isReadOnlyRuntimeTool } from '../toolMetadata';

describe('agent runtime tool metadata', () => {
  it('classifies read tools with resource domain and workspace need', () => {
    const metadata = buildAgentRuntimeToolMetadata({
      toolKey: 'mcp__lifecycle__get_file',
      catalogCapabilityId: 'github_read',
      capabilityKey: 'read',
      approvalMode: 'allow',
    });

    expect(metadata).toMatchObject({
      effect: 'read',
      exposure: 'read',
      resourceDomain: 'github',
      workspaceNeed: 'none',
    });
    expect(isReadOnlyRuntimeTool(metadata)).toBe(true);
  });

  it('classifies approval-gated write tools without creating Debug-specific clones', () => {
    const metadata = buildAgentRuntimeToolMetadata({
      toolKey: 'mcp__lifecycle__update_file',
      catalogCapabilityId: 'github_write',
      capabilityKey: 'git_write',
      approvalMode: 'require_approval',
    });

    expect(metadata).toMatchObject({
      effect: 'write',
      exposure: 'repair',
      resourceDomain: 'github',
      workspaceNeed: 'none',
    });
    expect(isApprovalGatedWriteRuntimeTool(metadata)).toBe(true);
  });
});
