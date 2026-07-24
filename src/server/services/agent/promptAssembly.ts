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

import type { AgentRunPlanSnapshotV1 } from './runPlanTypes';

export const INSTRUCTION_RULES_BLOCK_HEADER = 'Rules set by your administrator:';

export function buildSystemPrompt(parts: Array<string | undefined>): string | undefined {
  const normalized = parts.map((part) => part?.trim()).filter(Boolean) as string[];
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.join('\n\n');
}

export function readResolvedInstructionTexts(runPlan?: AgentRunPlanSnapshotV1 | null): string[] {
  return (runPlan?.prompt.resolvedInstructions || [])
    .map((instruction) => instruction.renderedText)
    .filter((text): text is string => typeof text === 'string' && Boolean(text.trim()));
}

export function renderInstructionRulesBlock(ruleContents: readonly string[]): string | undefined {
  const normalized = ruleContents.map((content) => content.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }

  const bullets = normalized.map((content) => `- ${content.split('\n').join('\n  ')}`);
  return [INSTRUCTION_RULES_BLOCK_HEADER, ...bullets].join('\n');
}

export function readResolvedRulesBlock(runPlan?: AgentRunPlanSnapshotV1 | null): string | undefined {
  return renderInstructionRulesBlock((runPlan?.prompt.resolvedRules || []).map((rule) => rule.content));
}
