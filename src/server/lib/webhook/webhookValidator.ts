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

import { Webhook } from 'server/models/yaml';

export interface WebhookValidationError {
  field: string;
  message: string;
}

/**
 * Validates webhook configuration based on its type
 * @param webhook The webhook to validate
 * @returns Array of validation errors, empty if valid
 */
export function validateWebhook(webhook: Webhook): WebhookValidationError[] {
  const errors: WebhookValidationError[] = [];

  // Common validations
  if (!webhook.type) {
    errors.push({ field: 'type', message: 'Webhook type is required' });
    return errors; // Can't validate further without type
  }

  if (!webhook.state) {
    errors.push({ field: 'state', message: 'Webhook state is required' });
  }

  if (!webhook.env || typeof webhook.env !== 'object') {
    errors.push({ field: 'env', message: 'Webhook env must be an object' });
  }

  // Type-specific validations
  switch (webhook.type) {
    case 'codefresh':
      if (!webhook.pipelineId) {
        errors.push({ field: 'pipelineId', message: 'Pipeline ID is required for codefresh webhooks' });
      }
      if (!webhook.trigger) {
        errors.push({ field: 'trigger', message: 'Trigger is required for codefresh webhooks' });
      }
      break;

    case 'docker':
      if (!webhook.docker) {
        errors.push({ field: 'docker', message: 'Docker configuration is required for docker webhooks' });
      } else {
        if (!webhook.docker.image) {
          errors.push({ field: 'docker.image', message: 'Docker image is required' });
        }
        if (webhook.docker.timeout && (webhook.docker.timeout <= 0 || webhook.docker.timeout > 86400)) {
          errors.push({ field: 'docker.timeout', message: 'Docker timeout must be between 1 and 86400 seconds' });
        }
      }
      break;

    case 'command':
      if (!webhook.command) {
        errors.push({ field: 'command', message: 'Command configuration is required for command webhooks' });
      } else {
        if (!webhook.command.image) {
          errors.push({ field: 'command.image', message: 'Command image is required' });
        }
        if (!webhook.command.script) {
          errors.push({ field: 'command.script', message: 'Command script is required' });
        }
        if (webhook.command.timeout && (webhook.command.timeout <= 0 || webhook.command.timeout > 86400)) {
          errors.push({ field: 'command.timeout', message: 'Command timeout must be between 1 and 86400 seconds' });
        }
      }
      break;

    default:
      errors.push({ field: 'type', message: `Invalid webhook type: ${webhook.type}` });
  }

  return errors;
}

/**
 * Validates all webhooks in an array
 * @param webhooks Array of webhooks to validate
 * @returns Map of webhook index to validation errors
 */
export function validateWebhooks(webhooks: Webhook[]): Map<number, WebhookValidationError[]> {
  const errorMap = new Map<number, WebhookValidationError[]>();

  webhooks.forEach((webhook, index) => {
    const errors = validateWebhook(webhook);
    if (errors.length > 0) {
      errorMap.set(index, errors);
    }
  });

  return errorMap;
}
