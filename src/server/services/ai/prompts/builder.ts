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

import { AI_AGENT_SYSTEM_PROMPT } from './systemPrompt';
import { DebugContext, DebugMessage } from '../../types/aiAgent';

export interface PromptContext {
  provider: 'anthropic' | 'openai' | 'gemini';
  debugContext: DebugContext;
  conversationHistory: DebugMessage[];
  userMessage: string;
}

export interface BuiltPrompt {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
}

type ConversationMode = 'investigation' | 'fix' | 'verification' | 'general';

export class AIAgentPromptBuilder {
  private basePrompt = AI_AGENT_SYSTEM_PROMPT;

  public build(context: PromptContext): BuiltPrompt {
    const layers = [
      this.basePrompt,
      this.buildProviderAugmentation(context.provider),
      this.buildConversationStateAugmentation(context),
      this.buildEnvironmentContext(context.debugContext),
    ];

    const systemPrompt = layers.filter(Boolean).join('\n');
    const messages = this.buildMessages(context);

    return { systemPrompt, messages };
  }

  private buildProviderAugmentation(provider: string): string {
    if (provider === 'gemini') {
      return `

---

# Gemini-Specific Instructions

## Tool Usage Behavior

CRITICAL: You are using the Gemini model. Follow these specific instructions:

1. **Execute Immediately - Do NOT Announce Intent:**
   - WRONG - Do NOT do these: "I will check the deployment status"
   - WRONG - Do NOT do these: "Let me get the logs"
   - WRONG - Do NOT do these: "I am going to scale the resource"
   - RIGHT - Do these instead: [Immediately call get_k8s_resources tool without saying anything]

2. **Call Tools Directly - Do NOT Generate Code:**
   - WRONG - Do NOT do these: Generating Python code like "api.get_k8s_resources(...)"
   - WRONG - Do NOT do these: Showing pseudocode like "result = call_tool(...)"
   - WRONG - Do NOT do these: Writing JavaScript/TypeScript snippets
   - WRONG - Do NOT do these: Generating any programming language code
   - RIGHT - Do these instead: [Use the actual function calling mechanism your model provides]

3. **Respect System Prompt - Do NOT Ignore Instructions:**
   - All instructions in this prompt are MANDATORY
   - If you announce instead of execute, you will be corrected
   - If you generate code instead of calling tools, you will fail
   - Tool calls are REQUIRED when actions are needed

## Fix Workflow Specific

When user confirms a fix (phrases: "yes", "fix it", "do it", "go ahead", "apply the fix", "user consents to fix"):

1. Call get_lifecycle_config or get_referenced_file (based on which file needs fixing)
2. Mentally process the content to identify the exact change needed
3. Call commit_lifecycle_fix or update_referenced_file with the complete corrected content
4. Wait for success response with commit_url
5. Output the fix summary with the commit URL

NEVER:
- Generate Python/JavaScript code snippets
- Show code like "lines = content.split('\\n')" or "lines[41] = ..."
- Claim you fixed something without calling the commit function
- Apply a different fix than what the user just requested
`;
    }

    return '';
  }

  private detectConversationMode(context: PromptContext): ConversationMode {
    const message = context.userMessage.toLowerCase();

    if (
      message.match(/^(yes|fix it|do it|go ahead|please fix|apply.*fix|fix that)$/i) ||
      message.includes('user consents to fix') ||
      message.includes('apply the fix')
    ) {
      return 'fix';
    }

    if (
      message.match(/(did you|have you).*(scale|restart|patch|delete|commit|fix|update)/i) ||
      message.match(/(are you sure|check again|verify|confirm)/i) ||
      message.includes('use the tool') ||
      message.includes('call the tool')
    ) {
      return 'verification';
    }

    if (message.match(/(why|what.*wrong|what.*fail|debug|investigate|check.*log|get.*log)/i)) {
      return 'investigation';
    }

    return 'general';
  }

  private buildConversationStateAugmentation(context: PromptContext): string {
    const mode = this.detectConversationMode(context);

    switch (mode) {
      case 'fix':
        return `

---

# Current Mode: FIX APPLICATION

The user has consented to apply a fix. Your immediate task:

1. Identify which file needs modification (lifecycle.yaml or a referenced file)
2. Call the appropriate get function to fetch current content
3. Mentally determine the exact change needed
4. Call the commit function with the complete corrected content
5. Return the commit URL in your response

DO NOT:
- Ask for permission (you already have it)
- Explain what you're going to do (just do it)
- Generate code snippets or pseudocode
- Fix anything other than what was just requested
`;

      case 'verification':
        return `

---

# Current Mode: VERIFICATION

The user is asking you to verify state or confirm an action. Your task:

1. Call verification tools to check current state:
   - get_k8s_resources for runtime state
   - get_lifecycle_config or get_referenced_file for configuration
   - query_database for deployment records
2. Report ACTUAL current state (not stale context)
3. Answer truthfully - if you didn't perform an action, admit it

DO NOT use stale context or assume state.
`;

      case 'investigation':
        return `

---

# Current Mode: INVESTIGATION

The user is asking you to investigate an issue. Your task:

1. Batch data collection (Step 1-2 of Debugging Workflow)
   - Get all database context in one query
   - Get all K8s resources in parallel
2. Analyze patterns (Step 3)
   - Identify common issues vs. unique issues
   - Determine if you should ask user which service to investigate
3. Execute targeted investigation (Step 4)
   - Follow the 7-Step Investigation Pattern
   - Compare DESIRED (config) vs ACTUAL (runtime) state
4. Provide structured summary (Step 5)

DO NOT:
- Investigate services one-by-one before batching data
- Commit fixes without user consent
- Skip configuration file reading
`;

      case 'general':
      default:
        return '';
    }
  }

  private buildEnvironmentContext(debugContext: DebugContext): string {
    const lc = debugContext.lifecycleContext;

    return `

---

# Current Environment Context

Build UUID: ${debugContext.buildUuid}
PR: #${lc.pullRequest.number || 'N/A'} - ${lc.pullRequest.title || 'N/A'}
Repository: ${lc.pullRequest.fullName}
Branch: ${lc.pullRequest.branch}
Build Status: ${lc.build.status}
Namespace: ${lc.build.namespace}
${
  lc.pullRequest.commentId
    ? `PR Comment ID: ${lc.pullRequest.commentId} (use get_pr_comment to see enabled services)`
    : 'PR Comment ID: Not available'
}

SERVICES (${lc.deploys.length}):
${lc.deploys
  .map((d) => {
    let info = `- ${d.serviceName}: ${d.status}${d.statusMessage ? ` - ${d.statusMessage}` : ''}`;
    info += `\n  Type: ${d.type}`;
    if (d.builderEngine) {
      info += `\n  Builder Engine: ${d.builderEngine}`;
    }
    if (d.helmChart) {
      info += `\n  Helm Chart: ${d.helmChart}`;
    }

    if (d.buildPipelineId) {
      info += `\n  Build: Codefresh (buildPipelineId: ${d.buildPipelineId})`;
    } else if (d.builderEngine) {
      info += `\n  Build: Native/${d.builderEngine} (use label_selector="lc-service=${d.serviceName}")`;
    }

    if (d.deployPipelineId) {
      info += `\n  Deploy: Codefresh (deployPipelineId: ${d.deployPipelineId})`;
    } else {
      info += `\n  Deploy: Native/Helm (use label_selector="lc-service=${d.serviceName}")`;
    }

    info += `\n  Image: ${d.dockerImage || 'N/A'}`;
    return info;
  })
  .join('\n')}

===== LIFECYCLE.YAML CONFIGURATION =====
${
  debugContext.lifecycleYaml
    ? debugContext.lifecycleYaml.error
      ? `Could not fetch lifecycle.yaml: ${debugContext.lifecycleYaml.error}`
      : `File: ${debugContext.lifecycleYaml.path}

\`\`\`yaml
${debugContext.lifecycleYaml.content}
\`\`\`

This is the source configuration for this environment. Check this for probe ports, resource limits, Dockerfile paths, etc.`
    : 'lifecycle.yaml not available'
}

INITIAL K8S STATE (STALE - call tools for current state):
${debugContext.services
  .map((s) => {
    const issues = s.issues.length > 0 ? ` | ${s.issues.length} issues` : '';
    const pods = s.pods.length > 0 ? ` | ${s.pods.length} pods` : '';
    return `- ${s.name}: ${s.status}${pods}${issues}`;
  })
  .join('\n')}`;
  }

  private buildMessages(context: PromptContext): Array<{ role: string; content: string }> {
    const messages = context.conversationHistory.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const contextSummary = this.generateContextSummary(context.debugContext);

    let finalMessage = context.userMessage;
    if (!context.userMessage.includes('[Current State]')) {
      finalMessage = `${context.userMessage}\n\n[Current State]\n${contextSummary}`;
    }

    messages.push({
      role: 'user',
      content: finalMessage,
    });

    return messages;
  }

  private generateContextSummary(context: DebugContext): string {
    const lc = context.lifecycleContext;
    const criticalIssues = context.services.flatMap((s) => s.issues).filter((i) => i.severity === 'critical');
    const prDisplay = lc.pullRequest.number ? `PR #${lc.pullRequest.number}` : `Build ${lc.build.uuid.slice(0, 8)}`;

    return `${prDisplay} | Build: ${lc.build.status} | Namespace: ${context.namespace}
Services: ${context.services.length} | Critical Issues: ${criticalIssues.length}`;
  }
}
