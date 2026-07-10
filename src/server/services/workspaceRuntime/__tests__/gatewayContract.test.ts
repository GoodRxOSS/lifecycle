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

import {
  WORKSPACE_GATEWAY_PREVIEW_PROXY_PROBE_PATH,
  buildWorkspaceGatewayPreviewProxyProbePath,
  buildWorkspaceGatewayContractFailureMessage,
  buildWorkspaceGatewayPreviewProxyFailureMessage,
  findMissingWorkspaceGatewayTools,
  REQUIRED_WORKSPACE_GATEWAY_HTTP_ROUTES,
  REQUIRED_WORKSPACE_GATEWAY_TOOLS,
  WORKSPACE_GATEWAY_CONTRACT_VERSION,
} from '../gatewayContract';

describe('workspace gateway contract', () => {
  it('passes when every required gateway tool is discovered', () => {
    expect(findMissingWorkspaceGatewayTools(REQUIRED_WORKSPACE_GATEWAY_TOOLS)).toEqual([]);
  });

  it('reports every missing required gateway tool', () => {
    const discovered = REQUIRED_WORKSPACE_GATEWAY_TOOLS.filter(
      (toolName) =>
        toolName !== 'workspace.service_start' &&
        toolName !== 'workspace.read_file' &&
        toolName !== 'workspace.list_files' &&
        toolName !== 'workspace.apply_patch'
    );

    expect(findMissingWorkspaceGatewayTools(discovered)).toEqual([
      'workspace.read_file',
      'workspace.list_files',
      'workspace.apply_patch',
      'workspace.service_start',
    ]);
  });

  it('builds an actionable provider-neutral failure message', () => {
    expect(buildWorkspaceGatewayContractFailureMessage(['workspace.service_start'])).toBe(
      `Workspace gateway contract v${WORKSPACE_GATEWAY_CONTRACT_VERSION} is not satisfied. Missing required MCP tools: workspace.service_start. Update the workspace gateway image/template used by this sandbox backend.`
    );
  });

  it('describes the required preview proxy HTTP route', () => {
    expect(REQUIRED_WORKSPACE_GATEWAY_HTTP_ROUTES).toEqual(['/preview/:port/*']);
    expect(WORKSPACE_GATEWAY_PREVIEW_PROXY_PROBE_PATH).toBe('/preview/<gateway-port>/health');
    expect(buildWorkspaceGatewayPreviewProxyProbePath(13338)).toBe('/preview/13338/health');
    expect(buildWorkspaceGatewayPreviewProxyFailureMessage(404)).toBe(
      `Workspace gateway contract v${WORKSPACE_GATEWAY_CONTRACT_VERSION} is not satisfied. Missing required HTTP route: /preview/:port/*. Expected authenticated GET /preview/<gateway-port>/health to return HTTP 200. Received HTTP 404. Update the workspace gateway image/template used by this sandbox backend.`
    );
  });
});
