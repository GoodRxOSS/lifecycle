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

const mockModeForCapability = jest.fn();
const mockExecuteWorkspaceCoreTool = jest.fn();
const mockResolveDurabilityConfig = jest.fn();

jest.mock('server/services/agent/PolicyService', () => ({
  __esModule: true,
  default: {
    modeForCapability: (...args: unknown[]) => mockModeForCapability(...args),
  },
}));

jest.mock('../adapters', () => ({
  executeWorkspaceCoreTool: (...args: unknown[]) => mockExecuteWorkspaceCoreTool(...args),
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    ...actual,
    resolveAgentSessionDurabilityConfig: (...args: unknown[]) => mockResolveDurabilityConfig(...args),
  };
});

import type { ToolSet } from 'ai';
import { configureAiToolFactories } from 'server/services/agent/capabilityToolHelpers';
import { registerWorkspaceCoreTools } from '../registration';

const resolvedCapabilityAccess = ['read_context', 'workspace_files', 'workspace_shell', 'preview_publish'].map(
  (capabilityId) => ({
    capabilityId,
    effectiveAvailability: 'all_users' as const,
    allowed: true,
    approvalMode: 'allow' as const,
  })
);

function registerForTest(overrides: Partial<Parameters<typeof registerWorkspaceCoreTools>[0]> = {}) {
  const tools: ToolSet = {};
  const toolMetadata: NonNullable<Parameters<typeof registerWorkspaceCoreTools>[0]['toolMetadata']> = [];
  const toolApproval: NonNullable<Parameters<typeof registerWorkspaceCoreTools>[0]['toolApproval']> = {};

  registerWorkspaceCoreTools({
    tools,
    session: { uuid: 'session-123' } as any,
    userIdentity: { userId: 'user-123' } as any,
    approvalPolicy: {} as any,
    workspaceGatewayServer: {
      scope: 'session',
      slug: 'sandbox',
      name: 'Session Workspace',
      transport: { type: 'http', url: 'http://workspace.example.test/mcp' },
      timeout: 1234,
      defaultArgs: {},
      env: {},
      discoveredTools: [],
    },
    workspaceToolExecutionTimeoutMs: 9999,
    resolvedCapabilityAccess,
    toolMetadata,
    toolApproval,
    ...overrides,
  });

  return { tools, toolMetadata, toolApproval };
}

describe('workspace_core registration', () => {
  beforeAll(() => {
    configureAiToolFactories({
      dynamicTool: (config: any) => config,
      jsonSchema: (schema: any) => schema,
    });
  });

  beforeEach(() => {
    mockModeForCapability.mockImplementation((_policy, capability) =>
      capability === 'workspace_write' || capability === 'shell_exec' ? 'require_approval' : 'allow'
    );
    mockExecuteWorkspaceCoreTool.mockReset();
    mockResolveDurabilityConfig.mockResolvedValue({ fileChangePreviewChars: 4000 });
  });

  it('records approval metadata without self-blocking require_approval tools inside execute', async () => {
    mockExecuteWorkspaceCoreTool.mockResolvedValue({
      applied: true,
      changed_files: ['src/app.ts'],
      diff: 'diff',
    });

    const { tools, toolMetadata, toolApproval } = registerForTest();
    const applyPatchTool = tools.mcp__workspace_core__apply_patch as any;

    const result = await applyPatchTool.execute(
      { patch: '*** Begin Patch\n*** End Patch\n' },
      { toolCallId: 'tool-call-1' }
    );

    expect(toolApproval.mcp__workspace_core__apply_patch).toBe('user-approval');
    expect(toolApproval.mcp__workspace_core__exec).toBe('user-approval');
    expect(toolApproval.mcp__workspace_core__list_files).toBeUndefined();
    expect(toolMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolKey: 'mcp__workspace_core__apply_patch',
          serverSlug: 'workspace_core',
          sourceToolName: 'apply_patch',
          catalogCapabilityId: 'workspace_files',
          capabilityKey: 'workspace_write',
          approvalMode: 'require_approval',
        }),
        expect.objectContaining({
          toolKey: 'mcp__workspace_core__list_files',
          serverSlug: 'workspace_core',
          sourceToolName: 'list_files',
          catalogCapabilityId: 'read_context',
          capabilityKey: 'read',
          approvalMode: 'allow',
        }),
      ])
    );
    expect(mockExecuteWorkspaceCoreTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'apply_patch' }),
      { patch: '*** Begin Patch\n*** End Patch\n' },
      expect.objectContaining({ timeoutMs: 9999 })
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: '{\n  "applied": true,\n  "changed_files": [\n    "src/app.ts"\n  ],\n  "diff": "diff"\n}',
        },
      ],
      structuredContent: {
        applied: true,
        changed_files: ['src/app.ts'],
        diff: 'diff',
      },
    });
  });

  it('returns a policy envelope when capability access denies execution', async () => {
    const { tools } = registerForTest({
      resolvedCapabilityAccess: resolvedCapabilityAccess.map((access) =>
        access.capabilityId === 'read_context' ? { ...access, allowed: false } : access
      ),
    });
    const listFilesTool = tools.mcp__workspace_core__list_files as any;

    const result = await listFilesTool.execute({ path: 'src' }, { toolCallId: 'tool-call-2' });

    expect(mockExecuteWorkspaceCoreTool).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: 'policy_denied',
      retry: 'never',
      message: 'workspace_core.list_files is not allowed by the current capability policy.',
      details: {
        tool: 'list_files',
        catalog_capability_id: 'read_context',
        runtime_capability: 'read',
      },
    });
    expect(result.isError).toBe(true);
  });

  it('emits proposed file-change previews for approval-gated workspace_core edits', async () => {
    const onFileChange = jest.fn();
    const { tools } = registerForTest({ hooks: { onFileChange } });
    const editFileTool = tools.mcp__workspace_core__edit_file as any;

    await editFileTool.onInputAvailable({
      toolCallId: 'tool-call-3',
      input: {
        path: '/workspace/src/app.ts',
        old_text: 'before',
        new_text: 'after',
      },
    });

    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-call-3:src/app.ts',
        toolCallId: 'tool-call-3',
        sourceTool: 'edit_file',
        path: '/workspace/src/app.ts',
        displayPath: 'src/app.ts',
        stage: 'awaiting-approval',
        beforeTextPreview: 'before',
        afterTextPreview: 'after',
      })
    );
  });
});
