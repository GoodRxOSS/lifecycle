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

import type {
  AgentSessionControlPlaneConfigValue,
  AgentSessionRuntimeSettingsValue,
} from 'server/services/types/agentSessionConfig';

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

function validatePositiveIntegerField(value: unknown, fieldName: string): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentSessionConfigValidationError(`${fieldName} must be a positive integer.`);
  }
}

function validateNonNegativeIntegerField(value: unknown, fieldName: string): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new AgentSessionConfigValidationError(`${fieldName} must be a non-negative integer.`);
  }
}

function validateStringRecord(value: unknown, fieldName: string): void {
  if (value === undefined) {
    return;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSessionConfigValidationError(`${fieldName} must be an object.`);
  }

  for (const [key, recordValue] of Object.entries(value)) {
    if (!key.trim()) {
      throw new AgentSessionConfigValidationError(`${fieldName} contains an empty key.`);
    }
    if (typeof recordValue !== 'string' || !recordValue.trim()) {
      throw new AgentSessionConfigValidationError(`${fieldName}.${key} must be a non-empty string.`);
    }
  }
}

function validateBooleanField(value: unknown, fieldName: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'boolean') {
    throw new AgentSessionConfigValidationError(`${fieldName} must be a boolean.`);
  }
}

export function validateAgentSessionControlPlaneConfig(config: Partial<AgentSessionControlPlaneConfigValue>): void {
  validatePromptField(config.systemPrompt, 'systemPrompt');
  validatePromptField(config.appendSystemPrompt, 'appendSystemPrompt');
  validatePositiveIntegerField(config.maxIterations, 'maxIterations');
  validatePositiveIntegerField(config.workspaceToolDiscoveryTimeoutMs, 'workspaceToolDiscoveryTimeoutMs');
  validatePositiveIntegerField(config.workspaceToolExecutionTimeoutMs, 'workspaceToolExecutionTimeoutMs');

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

export function validateAgentSessionRuntimeSettings(config: AgentSessionRuntimeSettingsValue): void {
  validatePromptField(config.workspaceImage, 'workspaceImage');
  validatePromptField(config.workspaceEditorImage, 'workspaceEditorImage');
  validatePromptField(config.workspaceGatewayImage, 'workspaceGatewayImage');
  validateStringRecord(config.scheduling?.nodeSelector, 'scheduling.nodeSelector');
  validateBooleanField(
    config.scheduling?.keepAttachedServicesOnSessionNode,
    'scheduling.keepAttachedServicesOnSessionNode'
  );
  validateNonNegativeIntegerField(config.readiness?.timeoutMs, 'readiness.timeoutMs');
  validateNonNegativeIntegerField(config.readiness?.pollMs, 'readiness.pollMs');
  validateStringRecord(config.resources?.workspace?.requests, 'resources.workspace.requests');
  validateStringRecord(config.resources?.workspace?.limits, 'resources.workspace.limits');
  validateStringRecord(config.resources?.editor?.requests, 'resources.editor.requests');
  validateStringRecord(config.resources?.editor?.limits, 'resources.editor.limits');
  validateStringRecord(config.resources?.workspaceGateway?.requests, 'resources.workspaceGateway.requests');
  validateStringRecord(config.resources?.workspaceGateway?.limits, 'resources.workspaceGateway.limits');
}
