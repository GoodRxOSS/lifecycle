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

const mockLoggerWarn = jest.fn();
const mockModeForCapability = jest.fn((_policy?: unknown, _capability?: unknown) => 'allow');
const mockDiagnosticToolExecute = jest.fn();

type MockDiagnosticTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: jest.Mock;
  setAllowedBuildUuid: jest.Mock;
  setSessionContext: jest.Mock;
  setWatchTarget: jest.Mock;
};

type MockGithubClient = {
  setAllowedBranch: jest.Mock;
  setReferencedFiles: jest.Mock;
  setExcludedFilePatterns: jest.Mock;
  setAllowedWritePatterns: jest.Mock;
  setAllowedRepos: jest.Mock;
  setDefaultRepo: jest.Mock;
  setAllowedPullRequestNumber: jest.Mock;
  setRequestAuth: jest.Mock;
  isFilePathAllowed: jest.Mock;
  validateBranch: jest.Mock;
  getOctokitWithAuth: jest.Mock;
  __requestAuth?: {
    resolveApprovalAuth?: (context: { toolCallId?: string | null }) => Promise<unknown>;
  };
};

const mockToolInstances: Record<string, MockDiagnosticTool[]> = {};
const mockGithubClientInstances: MockGithubClient[] = [];
const mockK8sClientInstances: Array<{ setAllowedNamespace: jest.Mock }> = [];
const mockDatabaseClientInstances: Array<{ setBuildScope: jest.Mock }> = [];

function mockMakeDiagnosticToolClass(name: string) {
  return jest.fn().mockImplementation(() => {
    const instance: MockDiagnosticTool = {
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} },
      execute: jest.fn((args, signal, context) => mockDiagnosticToolExecute(name, args, signal, context)),
      setAllowedBuildUuid: jest.fn(),
      setSessionContext: jest.fn(),
      setWatchTarget: jest.fn(),
    };
    (mockToolInstances[name] ||= []).push(instance);
    return instance;
  });
}

jest.mock('server/models', () => ({}));

jest.mock('server/services/agent/tools/shared/githubClient', () => ({
  GitHubClient: jest.fn().mockImplementation(() => {
    const client: MockGithubClient = {
      setAllowedBranch: jest.fn(),
      setReferencedFiles: jest.fn(),
      setExcludedFilePatterns: jest.fn(),
      setAllowedWritePatterns: jest.fn(),
      setAllowedRepos: jest.fn(),
      setDefaultRepo: jest.fn(),
      setAllowedPullRequestNumber: jest.fn(),
      setRequestAuth: jest.fn(function setRequestAuth(this: MockGithubClient, auth: MockGithubClient['__requestAuth']) {
        this.__requestAuth = auth;
      }),
      isFilePathAllowed: jest.fn(() => true),
      validateBranch: jest.fn(() => ({ valid: true })),
      getOctokitWithAuth: jest.fn(),
    };
    mockGithubClientInstances.push(client);
    return client;
  }),
}));

jest.mock('server/services/agent/tools/shared/k8sClient', () => ({
  K8sClient: jest.fn().mockImplementation(() => {
    const client = { setAllowedNamespace: jest.fn() };
    mockK8sClientInstances.push(client);
    return client;
  }),
}));

jest.mock('server/services/agent/tools/shared/databaseClient', () => ({
  DatabaseClient: jest.fn().mockImplementation(() => {
    const client = { setBuildScope: jest.fn() };
    mockDatabaseClientInstances.push(client);
    return client;
  }),
}));

jest.mock('server/services/agent/tools/codefresh/getCodefreshLogs', () => ({
  GetCodefreshLogsTool: mockMakeDiagnosticToolClass('get_codefresh_logs'),
}));
jest.mock('server/services/agent/tools/github/getFile', () => ({
  GetFileTool: mockMakeDiagnosticToolClass('get_file'),
}));
jest.mock('server/services/agent/tools/github/getIssueComment', () => ({
  GetIssueCommentTool: mockMakeDiagnosticToolClass('get_issue_comment'),
}));
jest.mock('server/services/agent/tools/github/listDirectory', () => ({
  ListDirectoryTool: mockMakeDiagnosticToolClass('list_directory'),
}));
jest.mock('server/services/agent/tools/github/updateFile', () => {
  const actual = jest.requireActual('server/services/agent/tools/github/updateFile');
  return { ...actual, UpdateFileTool: mockMakeDiagnosticToolClass('update_file') };
});
jest.mock('server/services/agent/tools/github/updatePrLabels', () => ({
  UpdatePrLabelsTool: mockMakeDiagnosticToolClass('update_pr_labels'),
}));
jest.mock('server/services/agent/tools/k8s/getK8sResources', () => ({
  GetK8sResourcesTool: mockMakeDiagnosticToolClass('get_k8s_resources'),
}));
jest.mock('server/services/agent/tools/k8s/getLifecycleLogs', () => ({
  GetLifecycleLogsTool: mockMakeDiagnosticToolClass('get_lifecycle_logs'),
}));
jest.mock('server/services/agent/tools/k8s/getPodLogs', () => ({
  GetPodLogsTool: mockMakeDiagnosticToolClass('get_pod_logs'),
}));
jest.mock('server/services/agent/tools/k8s/patchK8sResource', () => ({
  PatchK8sResourceTool: mockMakeDiagnosticToolClass('patch_k8s_resource'),
}));
jest.mock('server/services/agent/tools/k8s/queryDatabase', () => ({
  QueryDatabaseTool: mockMakeDiagnosticToolClass('query_database'),
}));
jest.mock('server/services/agent/tools/lifecycle/getBuildLogs', () => ({
  GetBuildLogsTool: mockMakeDiagnosticToolClass('get_build_logs'),
}));
jest.mock('server/services/agent/tools/lifecycle/getEnvironmentStatus', () => ({
  GetEnvironmentStatusTool: mockMakeDiagnosticToolClass('get_environment_status'),
}));
jest.mock('server/services/agent/tools/lifecycle/triggerRedeploy', () => ({
  TriggerRedeployTool: mockMakeDiagnosticToolClass('trigger_redeploy'),
}));
jest.mock('server/services/agent/tools/lifecycle/validateLifecycleConfig', () => ({
  ValidateLifecycleConfigTool: mockMakeDiagnosticToolClass('validate_lifecycle_config'),
}));

jest.mock('../PolicyService', () => ({
  __esModule: true,
  default: {
    modeForCapability: (...args: unknown[]) => mockModeForCapability(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  }),
}));

import {
  buildUpdateFilePreview,
  LIFECYCLE_DIAGNOSTIC_TOOL_MANIFEST,
  registerLifecycleDiagnosticFixTools,
  registerLifecycleDiagnosticReadTools,
  shouldRequestUpdateFileApproval,
} from '../diagnosticTools';
import { configureAiToolFactories } from '../capabilityToolHelpers';
import type { GitHubClient } from '../tools/shared/githubClient';

function buildGithubClient(currentContent: string | null): GitHubClient {
  const octokit = {
    request: jest.fn(async () => {
      if (currentContent === null) {
        throw new Error('not found');
      }

      return {
        data: {
          content: Buffer.from(currentContent).toString('base64'),
        },
      };
    }),
  };
  return {
    isFilePathAllowed: jest.fn(() => true),
    validateBranch: jest.fn(() => ({ valid: true })),
    getOctokit: jest.fn(async () => octokit),
    getOctokitWithAuth: jest.fn(async () => ({
      octokit,
      auth: { provider: 'github', source: 'app', required: false },
    })),
  } as unknown as GitHubClient;
}

const updateFileInput = {
  repository_owner: 'sample-owner',
  repository_name: 'sample-repo',
  branch: 'sample-branch',
  file_path: 'lifecycle.yaml',
  new_content: 'services:\n  - name: sample-service\n',
  commit_message: 'fix: update sample service',
};

configureAiToolFactories({
  dynamicTool: ((config: unknown) => config) as never,
  jsonSchema: ((schema: unknown) => schema) as never,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGithubClientInstances.length = 0;
  mockK8sClientInstances.length = 0;
  mockDatabaseClientInstances.length = 0;
  for (const name of Object.keys(mockToolInstances)) {
    mockToolInstances[name].length = 0;
  }
  mockModeForCapability.mockReturnValue('allow');
  mockDiagnosticToolExecute.mockResolvedValue({
    success: true,
    agentContent: 'diagnostic output',
    auth: { provider: 'github', source: 'app', required: false },
  });
});

describe('diagnostic update_file previews', () => {
  it('does not request approval or emit a file-change preview for no-op updates', async () => {
    const githubClient = buildGithubClient(updateFileInput.new_content);

    await expect(shouldRequestUpdateFileApproval(githubClient, updateFileInput)).resolves.toBe(false);
    await expect(buildUpdateFilePreview(githubClient, updateFileInput, 'tool-call-1', 'update_file')).resolves.toEqual(
      []
    );
  });

  it('requests approval and emits a diff preview when update_file changes content', async () => {
    const githubClient = buildGithubClient('services:\n  - name: old-service\n');

    await expect(shouldRequestUpdateFileApproval(githubClient, updateFileInput)).resolves.toBe(true);
    const [preview] = await buildUpdateFilePreview(githubClient, updateFileInput, 'tool-call-1', 'update_file');

    expect(preview).toEqual(
      expect.objectContaining({
        path: 'lifecycle.yaml',
        displayPath: 'lifecycle.yaml',
        additions: 1,
        deletions: 1,
        oldSha256: expect.any(String),
        newSha256: expect.any(String),
      })
    );
    expect(preview.unifiedDiff).toContain('-  - name: old-service');
    expect(preview.unifiedDiff).toContain('+  - name: sample-service');
  });

  it('judges literal backslash-escape sequences verbatim, matching what update_file commits', async () => {
    // File holds a real newline; the model echoes it as a two-char \n sequence.
    const currentContent = 'RUN printf "a\nb"\n';
    const escapedContent = 'RUN printf "a\\nb"\n';
    const githubClient = buildGithubClient(currentContent);
    const input = { ...updateFileInput, file_path: 'Dockerfile', new_content: escapedContent };

    await expect(shouldRequestUpdateFileApproval(githubClient, input)).resolves.toBe(true);

    const [preview] = await buildUpdateFilePreview(githubClient, input, 'tool-call-1', 'update_file');
    expect(preview.unifiedDiff).toContain('+RUN printf "a\\nb"');
    expect(preview.afterTextPreview).toContain('a\\nb');
  });

  it('stamps the schema verdict on lifecycle.yaml previews so the approver sees it', async () => {
    const githubClient = buildGithubClient('services:\n  - name: old-service\n');

    const [invalidPreview] = await buildUpdateFilePreview(
      githubClient,
      { ...updateFileInput, new_content: 'services:\n  - name: sample-service\n    bogusField: nope\n' },
      'tool-call-1',
      'update_file'
    );
    expect(invalidPreview.schemaValidation).toEqual(
      expect.objectContaining({ valid: false, error: expect.stringContaining('bogusField') })
    );

    const [nonConfigPreview] = await buildUpdateFilePreview(
      githubClient,
      { ...updateFileInput, file_path: 'Dockerfile', new_content: 'FROM node:20\n' },
      'tool-call-2',
      'update_file'
    );
    expect(nonConfigPreview.schemaValidation).toBeUndefined();
  });

  it('rejects incomplete or unsafe approval inputs before reading GitHub', async () => {
    const missingRequiredClient = buildGithubClient('existing content') as unknown as MockGithubClient;

    await expect(
      shouldRequestUpdateFileApproval(missingRequiredClient as unknown as GitHubClient, {
        ...updateFileInput,
        file_path: '   ',
      })
    ).resolves.toBe(false);
    await expect(
      shouldRequestUpdateFileApproval(missingRequiredClient as unknown as GitHubClient, {
        ...updateFileInput,
        branch: null,
      })
    ).resolves.toBe(false);
    await expect(
      shouldRequestUpdateFileApproval(missingRequiredClient as unknown as GitHubClient, {
        ...updateFileInput,
        new_content: null,
      })
    ).resolves.toBe(false);
    expect(missingRequiredClient.getOctokitWithAuth).not.toHaveBeenCalled();

    const unsafeClient = buildGithubClient('existing content') as unknown as MockGithubClient;
    unsafeClient.isFilePathAllowed.mockReturnValueOnce(false).mockReturnValue(true);

    await expect(
      shouldRequestUpdateFileApproval(unsafeClient as unknown as GitHubClient, updateFileInput)
    ).resolves.toBe(false);
    expect(unsafeClient.validateBranch).not.toHaveBeenCalled();

    unsafeClient.validateBranch.mockReturnValue({ valid: false });
    await expect(
      shouldRequestUpdateFileApproval(unsafeClient as unknown as GitHubClient, updateFileInput)
    ).resolves.toBe(false);
    expect(unsafeClient.getOctokitWithAuth).not.toHaveBeenCalled();
  });

  it('returns no preview for inputs without a string path or replacement content', async () => {
    const githubClient = buildGithubClient('existing content') as unknown as MockGithubClient;

    await expect(
      buildUpdateFilePreview(
        githubClient as unknown as GitHubClient,
        { ...updateFileInput, file_path: 42 },
        'tool-call-invalid-path',
        'update_file'
      )
    ).resolves.toEqual([]);
    await expect(
      buildUpdateFilePreview(
        githubClient as unknown as GitHubClient,
        { ...updateFileInput, new_content: undefined },
        'tool-call-invalid-content',
        'update_file'
      )
    ).resolves.toEqual([]);
    expect(githubClient.getOctokitWithAuth).not.toHaveBeenCalled();
  });

  it('describes a normalized new file when GitHub reports that no current file exists', async () => {
    const githubClient = buildGithubClient(null) as unknown as MockGithubClient;
    const content = 'FROM node:20\n';

    const [preview] = await buildUpdateFilePreview(
      githubClient as unknown as GitHubClient,
      {
        ...updateFileInput,
        file_path: '/./Dockerfile',
        new_content: content,
      },
      'tool-call-create',
      'update_file'
    );

    expect(preview).toEqual(
      expect.objectContaining({
        id: 'tool-call-create:Dockerfile',
        path: 'Dockerfile',
        displayPath: 'Dockerfile',
        kind: 'created',
        stage: 'awaiting-approval',
        additions: 2,
        deletions: 0,
        truncated: false,
        unifiedDiff: null,
        beforeTextPreview: null,
        afterTextPreview: content,
        oldSizeBytes: null,
        newSizeBytes: Buffer.byteLength(content),
        oldSha256: null,
        newSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    expect(githubClient.getOctokitWithAuth).toHaveBeenCalledWith('agent-runtime-update-file-preview', {
      requireUserAuth: false,
      toolCallId: 'tool-call-create',
    });
  });

  it('treats missing repository coordinates or non-file GitHub responses as a proposed creation', async () => {
    const missingRepoClient = buildGithubClient('existing content') as unknown as MockGithubClient;
    const [missingRepoPreview] = await buildUpdateFilePreview(
      missingRepoClient as unknown as GitHubClient,
      { ...updateFileInput, repository_owner: ' ' },
      'tool-call-no-repo',
      'update_file'
    );

    expect(missingRepoPreview.kind).toBe('created');
    expect(missingRepoClient.getOctokitWithAuth).not.toHaveBeenCalled();

    const request = jest.fn().mockResolvedValue({ data: [{ name: 'lifecycle.yaml' }] });
    const nonFileClient = {
      getOctokitWithAuth: jest.fn().mockResolvedValue({ octokit: { request } }),
    } as unknown as GitHubClient;
    const [nonFilePreview] = await buildUpdateFilePreview(
      nonFileClient,
      updateFileInput,
      'tool-call-directory',
      'update_file'
    );

    expect(nonFilePreview.kind).toBe('created');
    expect(request).toHaveBeenCalledWith('GET /repos/sample-owner/sample-repo/contents/lifecycle.yaml', {
      ref: 'sample-branch',
    });
  });

  it('represents both empty-file creation and clearing an existing file accurately', async () => {
    const missingFileClient = buildGithubClient(null);
    const [emptyCreation] = await buildUpdateFilePreview(
      missingFileClient,
      { ...updateFileInput, file_path: 'empty.txt', new_content: '' },
      'tool-call-empty-create',
      'update_file'
    );

    expect(emptyCreation).toEqual(
      expect.objectContaining({
        kind: 'created',
        additions: 0,
        deletions: 0,
        afterTextPreview: '',
        newSizeBytes: 0,
      })
    );

    const existingFileClient = buildGithubClient('first line\nsecond line');
    const [clearedFile] = await buildUpdateFilePreview(
      existingFileClient,
      { ...updateFileInput, file_path: 'notes.txt', new_content: '' },
      'tool-call-clear',
      'update_file'
    );

    expect(clearedFile).toEqual(
      expect.objectContaining({
        kind: 'edited',
        additions: 0,
        deletions: 2,
        afterTextPreview: '',
        newSizeBytes: 0,
      })
    );
    expect(clearedFile.unifiedDiff).toContain('-first line');
    expect(clearedFile.unifiedDiff).toContain('-second line');
  });

  it('uses a bounded coarse diff and truncates text previews for very large changes', async () => {
    const oldContent = Array.from({ length: 1001 }, (_, index) => `old-${index}`).join('\n');
    const newContent = Array.from({ length: 1001 }, (_, index) => `new-${index}`).join('\n');
    const githubClient = buildGithubClient(oldContent);

    const [preview] = await buildUpdateFilePreview(
      githubClient,
      { ...updateFileInput, file_path: 'generated.txt', new_content: newContent },
      'tool-call-large',
      'update_file'
    );

    expect(preview).toEqual(
      expect.objectContaining({
        kind: 'edited',
        additions: 1001,
        deletions: 1001,
        truncated: true,
        oldSizeBytes: Buffer.byteLength(oldContent),
        newSizeBytes: Buffer.byteLength(newContent),
      })
    );
    expect(preview.beforeTextPreview?.endsWith('[truncated]')).toBe(true);
    expect(preview.afterTextPreview?.endsWith('[truncated]')).toBe(true);
    expect(preview.unifiedDiff).toContain('@@ -1,1001 +1,1001 @@');
    expect(preview.unifiedDiff).toContain('-old-0');
    expect(preview.unifiedDiff).toContain('+new-1000');
  });
});

const approvalPolicy = {
  defaultMode: 'allow',
  rules: {},
} as any;

const session = {
  id: 41,
  uuid: 'session-uuid',
  namespace: 'sample-namespace',
  buildUuid: 'session-build-uuid',
} as any;

function allowedCapabilities(...capabilityIds: string[]) {
  return capabilityIds.map((capabilityId) => ({
    capabilityId,
    effectiveAvailability: 'all_users' as const,
    allowed: true,
    approvalMode: 'allow' as const,
  })) as any;
}

type RegisteredDiagnosticTool = {
  description: string;
  inputSchema: unknown;
  contextSchema: unknown;
  onInputAvailable?: (event: { input?: unknown; toolCallId?: string }) => Promise<void>;
  execute: (
    input?: unknown,
    context?: { toolCallId?: string; abortSignal?: AbortSignal; context?: Record<string, unknown> }
  ) => Promise<unknown>;
};

function registerCodefreshTool(options: Record<string, unknown> = {}) {
  const tools: Record<string, RegisteredDiagnosticTool> = {};
  registerLifecycleDiagnosticReadTools({
    tools: tools as any,
    session,
    approvalPolicy,
    resolvedCapabilityAccess: allowedCapabilities('diagnostics_codefresh'),
    ...options,
  });
  return tools.mcp__lifecycle__get_codefresh_logs;
}

describe('Lifecycle diagnostic tool registration', () => {
  it('publishes the complete unique diagnostic roster with its governing capability', () => {
    expect(LIFECYCLE_DIAGNOSTIC_TOOL_MANIFEST).toHaveLength(15);
    expect(LIFECYCLE_DIAGNOSTIC_TOOL_MANIFEST.map(({ toolName }) => toolName)).toEqual([
      'get_environment_status',
      'get_codefresh_logs',
      'get_k8s_resources',
      'get_pod_logs',
      'get_lifecycle_logs',
      'get_build_logs',
      'query_database',
      'validate_lifecycle_config',
      'get_file',
      'list_directory',
      'get_issue_comment',
      'update_file',
      'update_pr_labels',
      'patch_k8s_resource',
      'trigger_redeploy',
    ]);
    expect(new Set(LIFECYCLE_DIAGNOSTIC_TOOL_MANIFEST.map(({ toolName }) => toolName)).size).toBe(15);
    expect(LIFECYCLE_DIAGNOSTIC_TOOL_MANIFEST.filter(({ capabilityKey }) => capabilityKey === 'read')).toHaveLength(11);
    expect(
      LIFECYCLE_DIAGNOSTIC_TOOL_MANIFEST.filter(({ capabilityKey }) => capabilityKey === 'git_write')
    ).toHaveLength(2);
    expect(
      LIFECYCLE_DIAGNOSTIC_TOOL_MANIFEST.filter(({ capabilityKey }) => capabilityKey === 'deploy_k8s_mutation')
    ).toHaveLength(2);
  });

  it('does not expose tools without a build and applies restrictive client defaults', () => {
    const tools = {};
    const toolMetadata: unknown[] = [];
    const toolApproval = {};

    registerLifecycleDiagnosticReadTools({
      tools,
      session: { ...session, buildUuid: null },
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities('diagnostics_codefresh'),
      toolMetadata,
      toolApproval,
    });

    expect(tools).toEqual({});
    expect(toolMetadata).toEqual([]);
    expect(toolApproval).toEqual({});
    expect(mockModeForCapability).not.toHaveBeenCalled();
    expect(mockGithubClientInstances).toHaveLength(1);
    expect(mockGithubClientInstances[0].setAllowedBranch).not.toHaveBeenCalled();
    expect(mockGithubClientInstances[0].setReferencedFiles).toHaveBeenCalledWith([]);
    expect(mockGithubClientInstances[0].setExcludedFilePatterns).toHaveBeenCalledWith([]);
    expect(mockGithubClientInstances[0].setAllowedWritePatterns).toHaveBeenCalledWith([]);
    expect(mockGithubClientInstances[0].setAllowedRepos).toHaveBeenCalledWith(null);
    expect(mockGithubClientInstances[0].setDefaultRepo).toHaveBeenCalledWith(null);
    expect(mockGithubClientInstances[0].setAllowedPullRequestNumber).toHaveBeenCalledWith(null);
    expect(mockGithubClientInstances[0].setRequestAuth).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: null, source: 'none' })
    );
    expect(mockK8sClientInstances[0].setAllowedNamespace).toHaveBeenCalledWith(null);
    expect(mockDatabaseClientInstances[0].setBuildScope).toHaveBeenCalledWith(null);
  });

  it('registers only allowed read catalog groups and constrains every external client to build safety', () => {
    const tools: Record<string, RegisteredDiagnosticTool> = {};
    const toolMetadata: any[] = [];
    const toolApproval = {};
    const databaseScope = { buildUuid: 'database-build-uuid', namespace: 'database-namespace' } as any;
    const requestGitHubAuth = {
      githubToken: 'request-token',
      source: 'user' as const,
      githubUsername: 'sample-user',
      writeAuthorized: false,
    };

    registerLifecycleDiagnosticReadTools({
      tools: tools as any,
      session,
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities(
        'diagnostics_kubernetes',
        'diagnostics_codefresh',
        'diagnostics_logs',
        'diagnostics_database',
        'github_read'
      ),
      githubSafety: {
        allowedBranch: '  feature/safe  ',
        primaryRepoFullName: 'sample-owner/sample-repo',
        referencedFiles: ['lifecycle.yaml'],
        excludedFilePatterns: ['secrets/**'],
        allowedWritePatterns: ['deploy/**'],
        allowedNamespace: 'safe-namespace',
        allowedRepos: ['sample-owner/sample-repo'],
        buildUuid: 'safe-build-uuid',
        allowedPullRequestNumber: 123,
        databaseScope,
      },
      requestGitHubAuth,
      toolMetadata,
      toolApproval,
    });

    expect(Object.keys(tools)).toHaveLength(11);
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        'mcp__lifecycle__get_environment_status',
        'mcp__lifecycle__get_codefresh_logs',
        'mcp__lifecycle__get_k8s_resources',
        'mcp__lifecycle__get_pod_logs',
        'mcp__lifecycle__get_lifecycle_logs',
        'mcp__lifecycle__get_build_logs',
        'mcp__lifecycle__query_database',
        'mcp__lifecycle__validate_lifecycle_config',
        'mcp__lifecycle__get_file',
        'mcp__lifecycle__list_directory',
        'mcp__lifecycle__get_issue_comment',
      ])
    );
    expect(toolMetadata).toHaveLength(11);
    expect(toolMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolKey: 'mcp__lifecycle__get_codefresh_logs',
          sourceToolName: 'get_codefresh_logs',
          catalogCapabilityId: 'diagnostics_codefresh',
          capabilityKey: 'read',
          approvalMode: 'allow',
        }),
      ])
    );
    expect(toolApproval).toEqual({});

    const githubClient = mockGithubClientInstances[0];
    expect(githubClient.setAllowedBranch).toHaveBeenCalledWith('feature/safe');
    expect(githubClient.setReferencedFiles).toHaveBeenCalledWith(['lifecycle.yaml']);
    expect(githubClient.setExcludedFilePatterns).toHaveBeenCalledWith(['secrets/**']);
    expect(githubClient.setAllowedWritePatterns).toHaveBeenCalledWith(['deploy/**']);
    expect(githubClient.setAllowedRepos).toHaveBeenCalledWith(['sample-owner/sample-repo']);
    expect(githubClient.setDefaultRepo).toHaveBeenCalledWith('sample-owner/sample-repo');
    expect(githubClient.setAllowedPullRequestNumber).toHaveBeenCalledWith(123);
    expect(githubClient.setRequestAuth).toHaveBeenCalledWith(
      expect.objectContaining({ ...requestGitHubAuth, resolveApprovalAuth: undefined })
    );
    expect(mockK8sClientInstances[0].setAllowedNamespace).toHaveBeenCalledWith('safe-namespace');
    expect(mockDatabaseClientInstances[0].setBuildScope).toHaveBeenCalledWith(databaseScope);
    expect(mockToolInstances.get_lifecycle_logs[0].setAllowedBuildUuid).toHaveBeenCalledWith('safe-build-uuid');
    expect(mockToolInstances.get_build_logs[0].setAllowedBuildUuid).toHaveBeenCalledWith('safe-build-uuid');
    expect(mockToolInstances.get_environment_status[0].setSessionContext).toHaveBeenCalledWith({
      sessionDbId: 41,
      namespace: 'sample-namespace',
      buildUuid: 'session-build-uuid',
    });
  });

  it('filters unavailable catalog capabilities before consulting policy', () => {
    const tools = {};

    registerLifecycleDiagnosticReadTools({
      tools,
      session,
      approvalPolicy,
      resolvedCapabilityAccess: [
        {
          capabilityId: 'diagnostics_codefresh',
          effectiveAvailability: 'system_only',
          allowed: false,
          reason: 'disabled',
        },
      ] as any,
    });

    expect(tools).toEqual({});
    expect(mockModeForCapability).not.toHaveBeenCalled();

    const unresolvedTools = {};
    registerLifecycleDiagnosticReadTools({
      tools: unresolvedTools,
      session,
      approvalPolicy,
    });
    expect(unresolvedTools).toEqual({});
    expect(mockModeForCapability).not.toHaveBeenCalled();
  });

  it('honors tool-rule deny and lets an explicit allow override a denied read capability', () => {
    const toolKey = 'mcp__lifecycle__get_codefresh_logs';
    mockModeForCapability.mockReturnValue('allow');
    const deniedTools = {};

    registerLifecycleDiagnosticReadTools({
      tools: deniedTools,
      session,
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities('diagnostics_codefresh'),
      toolRules: [{ toolKey, mode: 'deny' }],
    });
    expect(deniedTools).toEqual({});

    mockModeForCapability.mockReturnValue('deny');
    const allowedTools = {};
    const toolMetadata: any[] = [];
    registerLifecycleDiagnosticReadTools({
      tools: allowedTools,
      session,
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities('diagnostics_codefresh'),
      toolRules: [{ toolKey, mode: 'allow' }],
      toolMetadata,
    });

    expect(allowedTools).toHaveProperty(toolKey);
    expect(toolMetadata).toEqual([expect.objectContaining({ toolKey, approvalMode: 'allow', capabilityKey: 'read' })]);

    const capabilityDeniedTools = {};
    registerLifecycleDiagnosticReadTools({
      tools: capabilityDeniedTools,
      session,
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities('diagnostics_codefresh'),
    });
    expect(capabilityDeniedTools).toEqual({});
  });

  it('keeps fix tools approval-gated even when a tool rule and capability policy allow them', async () => {
    const tools: Record<string, RegisteredDiagnosticTool> = {};
    const toolApproval: Record<string, unknown> = {};
    const toolMetadata: any[] = [];
    const updateFileToolKey = 'mcp__lifecycle__update_file';

    registerLifecycleDiagnosticFixTools({
      tools: tools as any,
      session,
      threadUuid: 'thread-uuid',
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities('github_write', 'diagnostics_kubernetes'),
      toolRules: [{ toolKey: updateFileToolKey, mode: 'allow' }],
      githubSafety: { buildUuid: 'safe-build-uuid', allowedNamespace: 'safe-namespace' },
      toolMetadata,
      toolApproval,
    });

    expect(Object.keys(tools)).toEqual([
      'mcp__lifecycle__update_file',
      'mcp__lifecycle__update_pr_labels',
      'mcp__lifecycle__patch_k8s_resource',
      'mcp__lifecycle__trigger_redeploy',
    ]);
    expect(typeof toolApproval.mcp__lifecycle__update_file).toBe('function');
    expect(toolApproval.mcp__lifecycle__update_pr_labels).toBe('user-approval');
    expect(toolApproval.mcp__lifecycle__patch_k8s_resource).toBe('user-approval');
    expect(toolApproval.mcp__lifecycle__trigger_redeploy).toBe('user-approval');
    expect(toolMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolKey: updateFileToolKey, approvalMode: 'require_approval' }),
      ])
    );
    expect(mockToolInstances.trigger_redeploy[0].setAllowedBuildUuid).toHaveBeenCalledWith('safe-build-uuid');
    expect(mockToolInstances.trigger_redeploy[0].setWatchTarget).toHaveBeenCalledWith({
      threadUuid: 'thread-uuid',
      sessionUuid: 'session-uuid',
    });
    expect(mockK8sClientInstances[0].setAllowedNamespace).toHaveBeenCalledWith('safe-namespace');

    const githubClient = mockGithubClientInstances[0];
    const request = jest.fn().mockResolvedValue({
      data: { content: Buffer.from(updateFileInput.new_content).toString('base64') },
    });
    githubClient.getOctokitWithAuth.mockResolvedValue({ octokit: { request } });
    const approval = toolApproval.mcp__lifecycle__update_file as (input: unknown) => Promise<unknown>;
    await expect(approval(updateFileInput)).resolves.toBe('not-applicable');
    await expect(approval({ ...updateFileInput, new_content: 'changed content' })).resolves.toBe('user-approval');
  });

  it('still omits fix tools denied by capability policy unless a tool rule explicitly allows them', () => {
    mockModeForCapability.mockReturnValue('deny');
    const deniedTools = {};
    registerLifecycleDiagnosticFixTools({
      tools: deniedTools,
      session,
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities('github_write'),
    });
    expect(deniedTools).toEqual({});

    const allowedTools = {};
    const toolApproval = {};
    registerLifecycleDiagnosticFixTools({
      tools: allowedTools,
      session,
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities('github_write'),
      toolRules: [{ toolKey: 'mcp__lifecycle__update_file', mode: 'allow' }],
      toolApproval,
    });
    expect(allowedTools).toHaveProperty('mcp__lifecycle__update_file');
    expect(allowedTools).not.toHaveProperty('mcp__lifecycle__update_pr_labels');
    expect(typeof (toolApproval as Record<string, unknown>).mcp__lifecycle__update_file).toBe('function');
  });

  it('binds approval-time GitHub auth to the active run and configures redeploy watch targets', async () => {
    const resolveApprovalGitHubAuth = jest
      .fn()
      .mockResolvedValueOnce({ githubToken: 'read-approval-token', source: 'user' })
      .mockResolvedValueOnce({ githubToken: 'fix-approval-token', source: 'user' });
    const requestGitHubAuth = { githubToken: 'request-token', source: 'user' as const };

    registerLifecycleDiagnosticReadTools({
      tools: {},
      session,
      approvalPolicy,
      resolvedCapabilityAccess: [],
      requestGitHubAuth,
      resolveApprovalGitHubAuth,
      hooks: { getActiveRunUuid: () => 'active-run-uuid' },
    });
    registerLifecycleDiagnosticFixTools({
      tools: {},
      session,
      threadUuid: null,
      approvalPolicy,
      resolvedCapabilityAccess: [],
      requestGitHubAuth,
      resolveApprovalGitHubAuth,
    });

    const readAuthConfig = mockGithubClientInstances[0].setRequestAuth.mock.calls[0][0];
    const fixAuthConfig = mockGithubClientInstances[1].setRequestAuth.mock.calls[0][0];
    await expect(readAuthConfig.resolveApprovalAuth({ toolCallId: 'read-tool-call' })).resolves.toEqual({
      githubToken: 'read-approval-token',
      source: 'user',
    });
    await expect(fixAuthConfig.resolveApprovalAuth({ toolCallId: 'fix-tool-call' })).resolves.toEqual({
      githubToken: 'fix-approval-token',
      source: 'user',
    });

    expect(resolveApprovalGitHubAuth).toHaveBeenNthCalledWith(1, {
      runUuid: 'active-run-uuid',
      toolCallId: 'read-tool-call',
    });
    expect(resolveApprovalGitHubAuth).toHaveBeenNthCalledWith(2, {
      runUuid: null,
      toolCallId: 'fix-tool-call',
    });
    expect(mockToolInstances.trigger_redeploy[0].setWatchTarget).toHaveBeenCalledWith(null);
  });
});

describe('Lifecycle diagnostic tool execution', () => {
  it('executes successfully when no optional audit hooks are configured', async () => {
    const tool = registerCodefreshTool();

    await expect(tool.execute({ pipeline_id: 'pipeline-without-hooks' })).resolves.toBe('diagnostic output');
    expect(mockDiagnosticToolExecute).toHaveBeenCalledWith(
      'get_codefresh_logs',
      { pipeline_id: 'pipeline-without-hooks' },
      undefined,
      { toolCallId: undefined }
    );
  });

  it('returns agent content and records successful execution with runtime context and auth', async () => {
    const onToolStarted = jest.fn();
    const onToolFinished = jest.fn();
    const abortController = new AbortController();
    const result = {
      success: true,
      agentContent: 'logs for the model',
      auth: { provider: 'codefresh', source: 'service', required: false },
    };
    mockDiagnosticToolExecute.mockResolvedValueOnce(result);
    const tool = registerCodefreshTool({ hooks: { onToolStarted, onToolFinished } });

    await expect(
      tool.execute(
        { pipeline_id: 'pipeline-1' },
        {
          toolCallId: 'tool-call-success',
          abortSignal: abortController.signal,
          context: {
            toolKey: 'runtime-tool-key',
            serverSlug: 'runtime-server',
            sourceToolName: 'runtime-codefresh-tool',
          },
        }
      )
    ).resolves.toBe('logs for the model');

    expect(onToolStarted).toHaveBeenCalledWith({
      source: 'mcp',
      serverSlug: 'runtime-server',
      toolName: 'runtime-codefresh-tool',
      toolCallId: 'tool-call-success',
      args: { pipeline_id: 'pipeline-1' },
      capabilityKey: 'read',
    });
    expect(mockDiagnosticToolExecute).toHaveBeenCalledWith(
      'get_codefresh_logs',
      { pipeline_id: 'pipeline-1' },
      abortController.signal,
      { toolCallId: 'tool-call-success' }
    );
    expect(onToolFinished).toHaveBeenCalledWith({
      source: 'mcp',
      serverSlug: 'runtime-server',
      toolName: 'runtime-codefresh-tool',
      toolCallId: 'tool-call-success',
      args: { pipeline_id: 'pipeline-1' },
      capabilityKey: 'read',
      result,
      status: 'completed',
      auth: result.auth,
    });
  });

  it('records a non-throwing tool failure while returning its agent-facing content', async () => {
    const onToolFinished = jest.fn();
    const result = {
      success: false,
      agentContent: 'The diagnostic request failed.',
      error: { code: 'UPSTREAM', message: 'Codefresh unavailable' },
    };
    mockDiagnosticToolExecute.mockResolvedValueOnce(result);
    const tool = registerCodefreshTool({ hooks: { onToolFinished } });

    await expect(tool.execute({ pipeline_id: 'pipeline-2' }, { toolCallId: 'tool-call-failed' })).resolves.toBe(
      result.agentContent
    );
    expect(onToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        result,
        auth: undefined,
      })
    );
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('audits, logs, and rethrows unexpected diagnostic errors', async () => {
    const onToolFinished = jest.fn();
    const error = new Error('Codefresh request crashed');
    mockDiagnosticToolExecute.mockRejectedValueOnce(error);
    const tool = registerCodefreshTool({ hooks: { onToolFinished } });

    await expect(tool.execute(undefined)).rejects.toThrow('Codefresh request crashed');

    expect(mockDiagnosticToolExecute).toHaveBeenCalledWith('get_codefresh_logs', {}, undefined, {
      toolCallId: undefined,
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { error },
      'AgentExec: lifecycle diagnostic tool failed sessionId=session-uuid tool=get_codefresh_logs'
    );
    expect(onToolFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'get_codefresh_logs',
        args: {},
        status: 'failed',
        result: { error: 'Codefresh request crashed' },
      })
    );
  });

  it('does not invoke the diagnostic boundary when the start-audit hook rejects', async () => {
    const onToolStarted = jest.fn().mockRejectedValue(new Error('audit unavailable'));
    const onToolFinished = jest.fn();
    const tool = registerCodefreshTool({ hooks: { onToolStarted, onToolFinished } });

    await expect(tool.execute({ pipeline_id: 'pipeline-3' })).rejects.toThrow('audit unavailable');
    expect(mockDiagnosticToolExecute).not.toHaveBeenCalled();
    expect(onToolFinished).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('emits proposed file changes only after an input event has a tool-call id', async () => {
    const onFileChange = jest.fn();
    const tools: Record<string, RegisteredDiagnosticTool> = {};
    registerLifecycleDiagnosticFixTools({
      tools: tools as any,
      session,
      approvalPolicy,
      resolvedCapabilityAccess: allowedCapabilities('github_write'),
      hooks: { onFileChange },
    });
    const updateFileTool = tools.mcp__lifecycle__update_file;
    const githubClient = mockGithubClientInstances[0];
    const request = jest.fn().mockResolvedValue({
      data: { content: Buffer.from('old content').toString('base64') },
    });
    githubClient.getOctokitWithAuth.mockResolvedValue({ octokit: { request } });

    await updateFileTool.onInputAvailable?.({ input: updateFileInput });
    expect(githubClient.getOctokitWithAuth).not.toHaveBeenCalled();
    expect(onFileChange).not.toHaveBeenCalled();

    await updateFileTool.onInputAvailable?.({ input: updateFileInput, toolCallId: 'tool-call-preview' });
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-call-preview:lifecycle.yaml',
        toolCallId: 'tool-call-preview',
        sourceTool: 'update_file',
        kind: 'edited',
        stage: 'awaiting-approval',
      })
    );
  });
});
