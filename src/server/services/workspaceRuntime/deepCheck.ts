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

import { randomUUID } from 'crypto';
import { BadRequestError, NotFoundError } from 'server/lib/appError';
import {
  resolveAgentSessionControlPlaneConfig,
  resolveAgentSessionRuntimeConfig,
  type AgentSessionRuntimeConfig,
} from 'server/lib/agentSession/runtimeConfig';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import { getLogger } from 'server/lib/logger';
import { getWorkspaceBackendDescriptor } from './registry';
import { buildWorkspaceGatewayAuthHeaders, mintWorkspaceGatewayToken } from './gatewayToken';
import { McpClientManager } from 'server/services/agentRuntime/mcp/client';
import { assertSafeProbeTargets, collectSecretValues, scrubWorkspaceBackendSecrets } from './probeSafety';
import { recordBackendVerification } from './verificationState';
import {
  buildWorkspaceGatewayContractFailureMessage,
  buildWorkspaceGatewayPreviewProxyProbePath,
  buildWorkspaceGatewayPreviewProxyFailureMessage,
  findMissingWorkspaceGatewayTools,
} from './gatewayContract';
import type {
  RemoteWorkspaceRuntimeProvider,
  WorkspaceBackendCapabilitySnapshot,
  WorkspaceBackendDeepCheckResult,
  WorkspaceBackendDeepCheckStage,
} from './types';

const GATEWAY_PREVIEW_PROXY_DEEP_CHECK_TIMEOUT_MS = 15000;

function resolveBackendGatewayPort(runtimeConfig: AgentSessionRuntimeConfig, backendId: string): number {
  switch (backendId) {
    case 'opensandbox':
      return runtimeConfig.workspaceBackend.opensandbox.gatewayPort;
    case 'e2b':
      return runtimeConfig.workspaceBackend.e2b.gatewayPort;
    case 'daytona':
      return runtimeConfig.workspaceBackend.daytona.gatewayPort;
    case 'modal':
      return runtimeConfig.workspaceBackend.modal.gatewayPort;
    default:
      return 13338;
  }
}

// Bare plan that boots a sandbox with no repos/skills/credentials — provision still creates the
// sandbox, starts the gateway (with token enforcement), and probes the editor, which is all the
// deep check needs. Reads only the documented subset of plan fields the providers touch.
function buildDeepCheckPlan(kind: WorkspaceRuntimePlan['kind']): WorkspaceRuntimePlan {
  return {
    version: 1,
    kind,
    sessionUuid: `deepcheck-${randomUUID()}`,
    forwardedEnv: { env: {}, secretRefs: [], secretProviders: [], secretServiceName: 'deep-check' },
    provider: { selection: { provider: 'none', modelId: 'none' }, apiKey: '', credentialEnv: {} },
    credentials: { hasGitHubToken: false, githubToken: null },
    startupMcp: { servers: [], serializedConfig: '[]' },
    servicePlan: { workspaceRepos: [], services: undefined, selectedServices: [] },
    skillPlan: { version: 1, skills: [] },
    runtimeConfig: {},
  } as unknown as WorkspaceRuntimePlan;
}

// Map a provision failure to the stage it belongs to, so the admin sees what to fix.
function classifyProvisionFailure(message: string): WorkspaceBackendDeepCheckStage {
  const lower = message.toLowerCase();
  if (/(create failed|missing sandbox id|template|snapshot|image)/.test(lower) && !/gateway/.test(lower)) {
    return { name: 'Create sandbox', status: 'failed', detail: message };
  }
  if (/(unauthenticated|not enforcing|outdated|enforce)/.test(lower)) {
    return { name: 'Gateway auth', status: 'failed', detail: message };
  }
  if (/(did not become|not ready|ready|timed out|timeout)/.test(lower)) {
    return { name: 'Gateway ready', status: 'failed', detail: message };
  }
  return { name: 'Provision', status: 'failed', detail: message };
}

function joinGatewayPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function checkGatewayTools({
  provider,
  providerState,
  gatewayToken,
  timeoutMs,
  secrets,
}: {
  provider: RemoteWorkspaceRuntimeProvider;
  providerState: Record<string, unknown>;
  gatewayToken: string;
  timeoutMs: number;
  secrets: string[];
}): Promise<WorkspaceBackendDeepCheckStage> {
  const endpoint = provider.resolveGatewayEndpoint(providerState);
  if (!endpoint) {
    return {
      name: 'Gateway tools',
      status: 'failed',
      detail: 'Workspace gateway endpoint could not be resolved after provisioning.',
    };
  }

  const client = new McpClientManager();
  try {
    await client.connect(
      {
        type: 'http',
        url: joinGatewayPath(endpoint.url, '/mcp'),
        headers: {
          ...(endpoint.headers || {}),
          ...buildWorkspaceGatewayAuthHeaders(gatewayToken),
        },
      },
      timeoutMs
    );
    const discoveredTools = await client.listTools(timeoutMs);
    const missing = findMissingWorkspaceGatewayTools(discoveredTools.map((tool) => tool.name));
    if (missing.length > 0) {
      return {
        name: 'Gateway tools',
        status: 'failed',
        detail: buildWorkspaceGatewayContractFailureMessage(missing),
      };
    }

    return {
      name: 'Gateway tools',
      status: 'passed',
      detail: `${discoveredTools.length} MCP tools discovered.`,
    };
  } catch (error) {
    const message = scrubWorkspaceBackendSecrets(error instanceof Error ? error.message : String(error), secrets);
    return { name: 'Gateway tools', status: 'failed', detail: message };
  } finally {
    await client.close();
  }
}

async function checkGatewayPreviewProxy({
  provider,
  providerState,
  gatewayToken,
  probePath,
  timeoutMs,
  secrets,
}: {
  provider: RemoteWorkspaceRuntimeProvider;
  providerState: Record<string, unknown>;
  gatewayToken: string;
  probePath: string;
  timeoutMs: number;
  secrets: string[];
}): Promise<WorkspaceBackendDeepCheckStage> {
  const endpoint = provider.resolveGatewayEndpoint(providerState);
  if (!endpoint) {
    return {
      name: 'Gateway preview proxy',
      status: 'failed',
      detail: 'Workspace gateway endpoint could not be resolved after provisioning.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(timeoutMs, GATEWAY_PREVIEW_PROXY_DEEP_CHECK_TIMEOUT_MS)
  );
  try {
    const response = await fetch(joinGatewayPath(endpoint.url, probePath), {
      method: 'GET',
      headers: {
        ...(endpoint.headers || {}),
        ...buildWorkspaceGatewayAuthHeaders(gatewayToken),
      },
      signal: controller.signal,
    });

    if (response.status === 200) {
      return {
        name: 'Gateway preview proxy',
        status: 'passed',
        detail: 'Authenticated /preview/:port route can proxy to the workspace gateway.',
      };
    }

    return {
      name: 'Gateway preview proxy',
      status: 'failed',
      detail: buildWorkspaceGatewayPreviewProxyFailureMessage(response.status),
    };
  } catch (error) {
    const message = scrubWorkspaceBackendSecrets(error instanceof Error ? error.message : String(error), secrets);
    return {
      name: 'Gateway preview proxy',
      status: 'failed',
      detail: `${buildWorkspaceGatewayPreviewProxyFailureMessage()} ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runProviderDeepCheck(
  provider: RemoteWorkspaceRuntimeProvider,
  kind: WorkspaceRuntimePlan['kind'],
  secrets: string[]
): Promise<WorkspaceBackendDeepCheckResult> {
  const runtimeConfig = await resolveAgentSessionRuntimeConfig();
  const controlPlaneConfig = await resolveAgentSessionControlPlaneConfig();
  const workspaceToolDiscoveryTimeoutMs = controlPlaneConfig.workspaceToolDiscoveryTimeoutMs;
  const previewProxyProbePath = buildWorkspaceGatewayPreviewProxyProbePath(
    resolveBackendGatewayPort(runtimeConfig, provider.backendId)
  );
  const plan = buildDeepCheckPlan(kind);
  const gatewayToken = mintWorkspaceGatewayToken();
  const stages: WorkspaceBackendDeepCheckStage[] = [];
  const startedAt = Date.now();

  let handle;
  try {
    handle = await provider.provision({ plan, readiness: runtimeConfig.readiness, gatewayToken });
  } catch (error) {
    const message = scrubWorkspaceBackendSecrets(error instanceof Error ? error.message : String(error), secrets);
    stages.push(classifyProvisionFailure(message));
    return { ok: false, message, durationMs: Date.now() - startedAt, stages };
  }

  const provisionMs = Date.now() - startedAt;
  stages.push({
    name: 'Provision & gateway',
    status: 'passed',
    detail: `Ready in ${(provisionMs / 1000).toFixed(1)}s`,
  });

  const gatewayToolsStage = await checkGatewayTools({
    provider,
    providerState: handle.providerState,
    gatewayToken,
    timeoutMs: workspaceToolDiscoveryTimeoutMs,
    secrets,
  });
  stages.push(gatewayToolsStage);

  const gatewayPreviewProxyStage: WorkspaceBackendDeepCheckStage =
    gatewayToolsStage.status === 'passed'
      ? await checkGatewayPreviewProxy({
          provider,
          providerState: handle.providerState,
          gatewayToken,
          probePath: previewProxyProbePath,
          timeoutMs: workspaceToolDiscoveryTimeoutMs,
          secrets,
        })
      : { name: 'Gateway preview proxy', status: 'skipped', detail: 'Gateway tools check failed.' };
  stages.push(gatewayPreviewProxyStage);

  const snapshot = handle.capabilitySnapshot as WorkspaceBackendCapabilitySnapshot;
  stages.push(
    snapshot.editorAccess
      ? { name: 'Editor', status: 'passed' }
      : { name: 'Editor', status: 'skipped', detail: 'No editor (image may not bundle code-server)' }
  );

  // Always tear the throwaway sandbox down; a failed teardown is reported but not fatal.
  try {
    await provider.destroy(handle.providerState);
    stages.push({ name: 'Teardown', status: 'passed' });
  } catch (error) {
    const message = scrubWorkspaceBackendSecrets(error instanceof Error ? error.message : String(error), secrets);
    getLogger().warn({ error }, 'Workspace deep check: teardown failed');
    stages.push({ name: 'Teardown', status: 'failed', detail: message });
  }

  return {
    ok: gatewayToolsStage.status === 'passed' && gatewayPreviewProxyStage.status === 'passed',
    message:
      gatewayToolsStage.status === 'passed' && gatewayPreviewProxyStage.status === 'passed'
        ? `Booted a test sandbox in ${(provisionMs / 1000).toFixed(1)}s.`
        : gatewayPreviewProxyStage.status === 'failed'
        ? gatewayPreviewProxyStage.detail || 'Workspace gateway preview proxy check failed.'
        : gatewayToolsStage.detail || 'Workspace gateway tool check failed.',
    durationMs: Date.now() - startedAt,
    stages,
  };
}

export async function runWorkspaceBackendDeepCheck(id: string): Promise<WorkspaceBackendDeepCheckResult> {
  const descriptor = getWorkspaceBackendDescriptor(id);
  if (!descriptor) {
    throw new NotFoundError(`Unknown workspace backend: ${id}`, 'workspace_backend_not_found');
  }
  if (descriptor.status !== 'available') {
    throw new BadRequestError(`The ${descriptor.displayName} workspace backend is not available yet.`);
  }
  if (!descriptor.createProvider) {
    throw new BadRequestError(`The ${descriptor.displayName} workspace backend does not support test sandboxes.`);
  }

  const { resolveAgentSessionWorkspaceBackendConfig } = await import('server/lib/agentSession/runtimeConfig');
  const config = await resolveAgentSessionWorkspaceBackendConfig();
  assertSafeProbeTargets(descriptor.id, config);
  const secrets = collectSecretValues(config);
  const provider = descriptor.createProvider(config);

  // Sandboxes accept all remote backends' workloads; 'chat' is the lightest provision path.
  const result = await runProviderDeepCheck(provider, 'chat', secrets);
  await recordBackendVerification(descriptor.id, { ok: result.ok, kind: 'deep' });
  return result;
}
