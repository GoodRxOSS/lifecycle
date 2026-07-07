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

import { NextRequest } from 'next/server';
import 'server/lib/dependencies';
import { createApiHandler } from 'server/lib/createApiHandler';
import { errorResponse, successResponse } from 'server/lib/response';
import AgentSessionConfigService from 'server/services/agentSessionConfig';
import InstructionTemplateService, {
  InstructionTemplateServiceError,
} from 'server/services/agent/InstructionTemplateService';
import InstructionRuleService from 'server/services/agent/InstructionRuleService';
import { buildSystemPrompt, renderInstructionRulesBlock } from 'server/services/agent/promptAssembly';

export const dynamic = 'force-dynamic';

/**
 * @openapi
 * /api/v2/ai/admin/agent/prompt-preview:
 *   get:
 *     summary: Preview the assembled system prompt for a built-in agent
 *     description: Assembles the effective system prompt (base prompt, agent instructions, rules, appended guidance) exactly as the run executor does, for the global scope or one repository. Session-dependent lines (equipped workspace tools and skills) vary per conversation and are excluded.
 *     tags:
 *       - Agent Admin
 *     operationId: getAdminAgentPromptPreview
 *     parameters:
 *       - in: query
 *         name: agent
 *         required: true
 *         schema:
 *           type: string
 *         description: Instruction template ref of the agent (for example system:debug).
 *       - in: query
 *         name: repository
 *         required: false
 *         schema:
 *           type: string
 *         description: Repository full name (owner/name) to preview repository overrides. Omit for global.
 *     responses:
 *       '200':
 *         description: Assembled prompt with labeled parts.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AdminAgentPromptPreviewSuccessResponse'
 *       '400':
 *         description: Validation error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '401':
 *         description: Unauthorized.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Agent instruction template not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest) => {
  const agentRef = req.nextUrl.searchParams.get('agent');
  const repository = req.nextUrl.searchParams.get('repository') || undefined;

  if (!agentRef) {
    return errorResponse(new Error('agent query parameter is required.'), { status: 400 }, req);
  }

  const configService = AgentSessionConfigService.getInstance();

  try {
    await InstructionTemplateService.seedSystemTemplates();
    const [template, globalConfig, repoConfig, effectiveConfig, resolvedRules] = await Promise.all([
      InstructionTemplateService.getTemplate(agentRef),
      configService.getGlobalConfig(),
      repository ? configService.getRepoConfig(repository) : Promise.resolve(null),
      configService.getEffectiveConfig(repository),
      InstructionRuleService.resolveForRun({ instructionRefs: [agentRef], repoFullName: repository }),
    ]);

    const promptSource = (repoValue?: string | null, globalValue?: string | null): string => {
      if (repoValue?.trim()) return 'repository';
      if (globalValue?.trim()) return 'global';
      return 'default';
    };

    const rulesBlock = renderInstructionRulesBlock(resolvedRules.map((rule) => rule.content));
    const parts = [
      {
        key: 'base',
        label: 'Base prompt (all agents)',
        source: promptSource(repoConfig?.systemPrompt, globalConfig.systemPrompt),
        content: effectiveConfig.systemPrompt,
      },
      {
        key: 'instructions',
        label: `${template.name} instructions`,
        source: template.effective.source,
        content: template.effective.content,
      },
      {
        key: 'rules',
        label: 'Rules',
        source: resolvedRules.length > 0 ? 'configured' : 'none',
        content: rulesBlock || '',
      },
      {
        key: 'appended',
        label: 'Response guidance (all agents)',
        source: promptSource(repoConfig?.appendSystemPrompt, globalConfig.appendSystemPrompt),
        content: effectiveConfig.appendSystemPrompt,
      },
    ];

    const assembled = buildSystemPrompt(parts.map((part) => part.content));

    return successResponse(
      {
        agent: { ref: template.ref, name: template.name },
        repository: repository || null,
        parts,
        rules: resolvedRules,
        assembled: assembled || '',
      },
      { status: 200 },
      req
    );
  } catch (error) {
    if (error instanceof InstructionTemplateServiceError) {
      return errorResponse(error, { status: error.statusCode === 404 ? 404 : 400 }, req);
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler, { auth: 'session', roles: ['admin'] });
