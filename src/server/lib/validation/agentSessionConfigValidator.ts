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

import type { AgentSessionControlPlaneConfigValue } from 'server/services/types/agentSessionConfig';

export class AgentSessionConfigValidationError extends Error {}

function validatePromptField(value: unknown, fieldName: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'string') {
    throw new AgentSessionConfigValidationError(`${fieldName} must be a string.`);
  }

  if (value.length > 50000) {
    throw new AgentSessionConfigValidationError(`${fieldName} exceeds maximum length of 50000 characters.`);
  }
}

export function validateAgentSessionControlPlaneConfig(config: Partial<AgentSessionControlPlaneConfigValue>): void {
  validatePromptField(config.systemPrompt, 'systemPrompt');
  validatePromptField(config.appendSystemPrompt, 'appendSystemPrompt');

  if (!config.toolRules) {
    return;
  }

  const seen = new Set<string>();
  for (const rule of config.toolRules) {
    if (!rule?.toolKey || typeof rule.toolKey !== 'string') {
      throw new AgentSessionConfigValidationError('toolRules entries must include a non-empty toolKey.');
    }
    if (rule.toolKey.length > 255) {
      throw new AgentSessionConfigValidationError(`toolRules entry "${rule.toolKey}" exceeds maximum toolKey length.`);
    }
    if (rule.mode !== 'allow' && rule.mode !== 'deny') {
      throw new AgentSessionConfigValidationError(
        `toolRules entry "${rule.toolKey}" has unsupported mode "${rule.mode}".`
      );
    }
    if (seen.has(rule.toolKey)) {
      throw new AgentSessionConfigValidationError(`Duplicate tool rule "${rule.toolKey}" is not allowed.`);
    }
    seen.add(rule.toolKey);
  }
}
