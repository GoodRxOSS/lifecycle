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

export const WORKSPACE_GATEWAY_CONTRACT_VERSION = 2;

export const REQUIRED_WORKSPACE_GATEWAY_HTTP_ROUTES = ['/preview/:port/*'] as const;

export const WORKSPACE_GATEWAY_PREVIEW_PROXY_PROBE_PATH = '/preview/<gateway-port>/health';

export function buildWorkspaceGatewayPreviewProxyProbePath(gatewayPort: number): string {
  return `/preview/${gatewayPort}/health`;
}

export const REQUIRED_WORKSPACE_GATEWAY_TOOLS = [
  'skills.list',
  'skills.learn',
  'workspace.read_file',
  'workspace.list_files',
  'workspace.write_file',
  'workspace.edit_file',
  'workspace.apply_patch',
  'workspace.glob',
  'workspace.exec',
  'workspace.operation_status',
  'workspace.operation_wait',
  'workspace.operation_logs',
  'workspace.operation_cancel',
  'workspace.operation_list',
  'workspace.service_start',
  'workspace.service_status',
  'workspace.service_logs',
  'workspace.service_stop',
  'workspace.service_list',
  'workspace.grep',
  'session.get_workspace_state',
  'git.status',
  'git.diff',
  'git.add',
  'git.commit',
  'git.branch',
  'session.list_ports',
  'session.list_processes',
  'session.get_service_status',
] as const;

export type RequiredWorkspaceGatewayTool = (typeof REQUIRED_WORKSPACE_GATEWAY_TOOLS)[number];

export function findMissingWorkspaceGatewayTools(toolNames: Iterable<string>): RequiredWorkspaceGatewayTool[] {
  const discovered = new Set(toolNames);
  return REQUIRED_WORKSPACE_GATEWAY_TOOLS.filter((toolName) => !discovered.has(toolName));
}

export function buildWorkspaceGatewayContractFailureMessage(missingTools: readonly string[]): string {
  return [
    `Workspace gateway contract v${WORKSPACE_GATEWAY_CONTRACT_VERSION} is not satisfied.`,
    `Missing required MCP tools: ${missingTools.join(', ')}.`,
    'Update the workspace gateway image/template used by this sandbox backend.',
  ].join(' ');
}

export function buildWorkspaceGatewayPreviewProxyFailureMessage(statusCode?: number): string {
  const observed = Number.isInteger(statusCode) ? ` Received HTTP ${statusCode}.` : '';
  return [
    `Workspace gateway contract v${WORKSPACE_GATEWAY_CONTRACT_VERSION} is not satisfied.`,
    `Missing required HTTP route: ${REQUIRED_WORKSPACE_GATEWAY_HTTP_ROUTES[0]}.`,
    `Expected authenticated GET ${WORKSPACE_GATEWAY_PREVIEW_PROXY_PROBE_PATH} to return HTTP 200.${observed}`,
    'Update the workspace gateway image/template used by this sandbox backend.',
  ].join(' ');
}
