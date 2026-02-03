/**
 * Copyright 2025 GoodRx, Inc.
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

import { assembleBasePrompt, PROMPT_SECTIONS } from './sectionRegistry';

import { DebugContext, DebugMessage, ServiceDebugInfo } from '../../types/aiAgent';
import { summarizeLifecycleYaml } from '../context/contextSummarizer';

export interface McpToolInfo {
  serverName: string;
  serverSlug: string;
  toolName: string;
  qualifiedName: string;
  description: string;
}

export interface PromptContext {
  provider: 'anthropic' | 'openai' | 'gemini';
  debugContext: DebugContext;
  conversationHistory: DebugMessage[];
  userMessage: string;
  additiveRules?: string[];
  systemPromptOverride?: string;
  excludedTools?: string[];
  excludedFilePatterns?: string[];
  mcpTools?: McpToolInfo[];
  excludeSections?: string[];
}

export interface BuiltPrompt {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
}

export class AIAgentPromptBuilder {
  private basePrompt = assembleBasePrompt();

  public build(context: PromptContext): BuiltPrompt {
    const excluded = context.excludeSections || [];
    const registryExcludes = [...excluded.filter((id) => id !== 'safety')];
    const base =
      context.systemPromptOverride || (excluded.length > 0 ? assembleBasePrompt(registryExcludes) : this.basePrompt);

    const layers = [
      base,
      this.buildMcpToolsLayer(context.mcpTools),
      this.buildCustomRulesLayer(context),
      this.buildAccessRestrictionsNotice(context),
      excluded.includes('safety') ? '' : this.buildSafetyRulesLayer(),
    ];

    const systemPrompt = layers.filter(Boolean).join('\n');
    const messages = this.buildMessages(context);

    return { systemPrompt, messages };
  }

  private buildCustomRulesLayer(context: PromptContext): string {
    if (!context.additiveRules || context.additiveRules.length === 0) {
      return '';
    }

    const rules = context.additiveRules.map((rule) => `- ${rule}`).join('\n');
    return `\n\n---\n\n# Custom Rules\n\n${rules}`;
  }

  private buildAccessRestrictionsNotice(context: PromptContext): string {
    const parts: string[] = [];
    if (context.excludedTools && context.excludedTools.length > 0) {
      parts.push(
        `The following tools are NOT available to you: ${context.excludedTools.join(', ')}. Do not attempt to use them.`
      );
    }
    if (context.excludedFilePatterns && context.excludedFilePatterns.length > 0) {
      parts.push(
        `The following file patterns are restricted and you cannot access them: ${context.excludedFilePatterns.join(
          ', '
        )}. If a user asks about these files, explain they are restricted.`
      );
    }
    if (parts.length === 0) return '';
    return `\n\n---\n\n# Access Restrictions\n\n${parts.join('\n\n')}`;
  }

  private buildMcpToolsLayer(mcpTools?: McpToolInfo[]): string {
    if (!mcpTools || mcpTools.length === 0) return '';

    const byServer = new Map<string, McpToolInfo[]>();
    for (const tool of mcpTools) {
      const key = tool.serverName;
      if (!byServer.has(key)) byServer.set(key, []);
      byServer.get(key)!.push(tool);
    }

    const serverSections = Array.from(byServer.entries())
      .map(([serverName, tools]) => {
        const toolList = tools.map((t) => `- **${t.qualifiedName}**: ${t.description}`).join('\n');
        return `### ${serverName}\n${toolList}`;
      })
      .join('\n\n');

    return `

---

# External Tools (MCP)

You have access to external tools from connected MCP servers. Use these tools when they can provide better or additional information beyond your built-in tools.

${serverSections}

**When to use MCP tools:**
- Use them alongside built-in tools during investigation — they provide complementary data
- If an MCP tool can answer the user's question directly, prefer it over manual investigation
- MCP tool names are prefixed with \`mcp__<server>__\` — call them like any other tool
- If an MCP tool fails, fall back to built-in tools`;
  }

  private buildSafetyRulesLayer(): string {
    return '\n\n---\n\n' + PROMPT_SECTIONS.find((s) => s.id === 'safety')!.content;
  }

  private static FAILED_DEPLOY_STATUSES = new Set(['BUILD_FAILED', 'DEPLOY_FAILED', 'ERROR']);

  private isFailingService(deploy: any, serviceDebug?: ServiceDebugInfo): boolean {
    if (AIAgentPromptBuilder.FAILED_DEPLOY_STATUSES.has(deploy.status)) return true;
    if (serviceDebug?.status === 'failed') return true;
    if (serviceDebug?.issues && serviceDebug.issues.length > 0) return true;
    return false;
  }

  private renderFailingService(d: any, serviceDebug?: ServiceDebugInfo): string {
    let info = `- ${d.serviceName}: ${d.status}${d.statusMessage ? ` - ${d.statusMessage}` : ''}`;
    info += `\n  Type: ${d.type}`;
    if (d.builderEngine) info += ` | Builder: ${d.builderEngine}`;
    if (d.helmChart) info += ` | Chart: ${d.helmChart}`;

    if (d.buildPipelineId) {
      info += `\n  Build: Codefresh (buildPipelineId: ${d.buildPipelineId})`;
    } else if (d.builderEngine) {
      info += `\n  Build: Native/${d.builderEngine} (label_selector="lc-service=${d.serviceName}")`;
    }

    if (d.deployPipelineId) {
      info += `\n  Deploy: Codefresh (deployPipelineId: ${d.deployPipelineId})`;
    } else {
      info += `\n  Deploy: Native/Helm (label_selector="lc-service=${d.serviceName}")`;
    }

    info += `\n  Image: ${d.dockerImage || 'N/A'}`;

    if (serviceDebug) {
      const podCount = serviceDebug.pods.length;
      const readyPods = serviceDebug.pods.filter(
        (p) => p.phase === 'Running' && p.containerStatuses.every((c: any) => c.ready)
      ).length;
      if (podCount > 0) {
        info += `\n  K8s: ${readyPods}/${podCount} pods ready`;
      }
      if (serviceDebug.issues.length > 0) {
        info += `\n  Issues: ${serviceDebug.issues.map((i) => i.title).join('; ')}`;
      }
      if (serviceDebug.events.length > 0) {
        const warningEvents = serviceDebug.events.filter((e) => e.type === 'Warning');
        if (warningEvents.length > 0) {
          info += `\n  Events: ${warningEvents
            .slice(0, 3)
            .map((e) => `${e.reason}: ${e.message}`)
            .join('; ')}`;
        }
      }
    }

    return info;
  }

  private renderRepoGroup(failing: any[], healthy: any[], servicesByName: Map<string, ServiceDebugInfo>): string {
    let section = '';
    if (failing.length > 0) {
      section += '\nFAILING:';
      for (const d of failing) {
        section += '\n' + this.renderFailingService(d, servicesByName.get(d.serviceName));
      }
    }
    if (healthy.length > 30) {
      section += `\n\nHEALTHY: ${healthy.length} services (use query_database on deploys table to list specific services)`;
    } else if (healthy.length > 0) {
      section += `\n\nHEALTHY (${healthy.length}): ${healthy.map((d) => d.serviceName).join(', ')}`;
    }
    return section;
  }

  private buildEnvironmentContext(debugContext: DebugContext): string {
    const lc = debugContext.lifecycleContext;
    const servicesByName = new Map<string, ServiceDebugInfo>();
    for (const s of debugContext.services) {
      servicesByName.set(s.name, s);
    }

    const failingDeploys: any[] = [];
    const healthyDeploys: any[] = [];
    for (const d of lc.deploys) {
      const serviceDebug = servicesByName.get(d.serviceName);
      if (this.isFailingService(d, serviceDebug)) {
        failingDeploys.push(d);
      } else {
        healthyDeploys.push(d);
      }
    }

    const repoNames = new Set<string>();
    for (const d of lc.deploys) {
      repoNames.add(d.repoName || lc.pullRequest.fullName);
    }
    const isMultiRepo = repoNames.size > 1;

    let servicesSection = `## Services (${lc.deploys.length} total, ${failingDeploys.length} failing)`;

    if (isMultiRepo) {
      const repoGroups = new Map<string, { failing: any[]; healthy: any[] }>();
      for (const d of [...failingDeploys, ...healthyDeploys]) {
        const repo = d.repoName || lc.pullRequest.fullName;
        if (!repoGroups.has(repo)) repoGroups.set(repo, { failing: [], healthy: [] });
        const group = repoGroups.get(repo)!;
        if (failingDeploys.includes(d)) {
          group.failing.push(d);
        } else {
          group.healthy.push(d);
        }
      }
      for (const [repo, group] of repoGroups) {
        servicesSection += `\n\n### ${repo}`;
        servicesSection += this.renderRepoGroup(group.failing, group.healthy, servicesByName);
      }
    } else {
      servicesSection += this.renderRepoGroup(failingDeploys, healthyDeploys, servicesByName);
    }

    let lifecycleYamlSection: string;
    if (!debugContext.lifecycleYaml) {
      lifecycleYamlSection = 'lifecycle.yaml not available';
    } else if (debugContext.lifecycleYaml.error) {
      lifecycleYamlSection = `Could not fetch lifecycle.yaml: ${debugContext.lifecycleYaml.error}`;
    } else if (debugContext.lifecycleYaml.content) {
      const summary = summarizeLifecycleYaml(debugContext.lifecycleYaml.content);
      if (summary.parsed) {
        lifecycleYamlSection = `${summary.text}\n[Use get_file("lifecycle.yaml") for full configuration]`;
      } else {
        const lines = debugContext.lifecycleYaml.content.split('\n');
        const truncated = lines.slice(0, 200).join('\n');
        lifecycleYamlSection = `${truncated}${
          lines.length > 200
            ? `\n... (${
                lines.length - 200
              } more lines truncated)\n[Use get_file("lifecycle.yaml") for full configuration]`
            : ''
        }`;
      }
    } else {
      lifecycleYamlSection = 'lifecycle.yaml is empty';
    }

    const gatheredAt =
      debugContext.gatheredAt instanceof Date ? debugContext.gatheredAt.toISOString() : String(debugContext.gatheredAt);

    return `

---

# Environment State (gathered: ${gatheredAt})

Build: ${debugContext.buildUuid} | Status: ${lc.build.status} | Namespace: ${lc.build.namespace}
PR: #${lc.pullRequest.number || 'N/A'} "${lc.pullRequest.title || 'N/A'}" by ${lc.pullRequest.username || 'N/A'}
Repo: ${lc.pullRequest.fullName} @ ${lc.pullRequest.branch} (base: ${lc.pullRequest.baseBranch || 'N/A'})
SHA: ${lc.pullRequest.latestCommit || lc.build.sha || 'N/A'}
${
  lc.pullRequest.commentId
    ? `PR Comment ID: ${lc.pullRequest.commentId} (use get_pr_comment to see enabled services)`
    : 'PR Comment ID: Not available'
}

${servicesSection}

## Configuration (lifecycle.yaml)
${lifecycleYamlSection}`;
  }

  private buildMessages(context: PromptContext): Array<{ role: string; content: string }> {
    const messages = context.conversationHistory.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const envContext = this.buildEnvironmentContext(context.debugContext);
    const finalMessage = `${envContext}\n\n${context.userMessage}`;

    messages.push({
      role: 'user',
      content: finalMessage,
    });

    return messages;
  }
}
