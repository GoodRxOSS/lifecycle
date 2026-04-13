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

import AIAgentConfigService from 'server/services/aiAgentConfig';
import type { AgentApprovalMode, AgentApprovalPolicy, AgentCapabilityKey } from './types';
import { DEFAULT_AGENT_APPROVAL_POLICY } from './types';

type McpAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

type ApprovalPolicyConfig = Partial<AgentApprovalPolicy> & {
  defaultMode?: AgentApprovalMode;
  rules?: Partial<Record<AgentCapabilityKey, AgentApprovalMode>>;
};

export default class AgentPolicyService {
  static async getEffectivePolicy(repoFullName?: string): Promise<AgentApprovalPolicy> {
    const config = await AIAgentConfigService.getInstance().getEffectiveConfig(repoFullName);
    const configured = (config as { approvalPolicy?: ApprovalPolicyConfig }).approvalPolicy;

    return {
      defaultMode: configured?.defaultMode || DEFAULT_AGENT_APPROVAL_POLICY.defaultMode,
      rules: {
        ...DEFAULT_AGENT_APPROVAL_POLICY.rules,
        ...(configured?.rules || {}),
      },
    };
  }

  static capabilityForMcpTool(toolName: string, annotations?: McpAnnotations): AgentCapabilityKey {
    if (annotations?.readOnlyHint) {
      return 'read';
    }

    const lowerName = toolName.toLowerCase();
    if (
      lowerName.includes('read') ||
      lowerName.includes('list') ||
      lowerName.includes('status') ||
      lowerName.includes('grep') ||
      lowerName.includes('diff')
    ) {
      return 'read';
    }

    if (lowerName.includes('write') || lowerName.includes('edit')) {
      return 'workspace_write';
    }

    if (lowerName.includes('exec') || lowerName.includes('bash') || lowerName.includes('command')) {
      return 'shell_exec';
    }

    if (lowerName.startsWith('git.') || lowerName.startsWith('git_') || lowerName.includes('git')) {
      return 'git_write';
    }

    if (annotations?.openWorldHint) {
      return 'network_access';
    }

    return 'external_mcp_write';
  }

  static modeForCapability(policy: AgentApprovalPolicy, capabilityKey: AgentCapabilityKey): AgentApprovalMode {
    return policy.rules[capabilityKey] || policy.defaultMode;
  }
}
