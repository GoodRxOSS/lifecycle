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

import type { McpJsonObject } from './contracts';
import { compileMcpJsonValidator, schemaValidationSummary } from './schemaValidator';

export const MCP_EXECUTION_ERROR_CODES = [
  'forbidden_repository',
  'api_environments_disabled',
  'toolset_disabled',
  'rate_limited',
  'wait_capacity',
  'env_not_found',
  'repo_not_onboarded',
  'site_not_found',
  'logs_not_found',
  'service_not_found',
  'job_not_found',
  'env_ambiguous',
  'invalid_body',
  'invalid_cursor',
  'name_conflict',
  'idempotency_conflict',
  'expiry_conflict',
  'environment_replaced',
  'env_tearing_down',
  'deploy_disabled',
  'env_static_protected',
  'env_pr_protected',
  'pr_environment_not_extendable',
  'forbidden_role',
  'config_invalid',
  'auto_track_pinned_source',
  'invalid_field_for_trigger',
  'override_not_allowed',
  'confirm_token_invalid',
  'confirm_token_expired',
  'unsupported_log_source',
  'upstream_unavailable',
  'internal_error',
] as const;

export type McpExecutionErrorCode = (typeof MCP_EXECUTION_ERROR_CODES)[number];
export type McpNextAction = 'none' | 'retry' | 'fix_input' | 'confirm' | 'escalate';
export type McpErrorDetailsKind =
  | 'env_not_found'
  | 'valid_services'
  | 'available_jobs'
  | 'validation'
  | 'current_expiry'
  | 'environment_replacement'
  | 'ambiguous_environment';

interface ErrorMetadata {
  retryable: boolean;
  nextAction: McpNextAction;
  retryAfter: 'forbidden' | 'optional' | 'required';
  detailsKind?: McpErrorDetailsKind;
}

const MCP_ERROR_METADATA: Record<McpExecutionErrorCode, ErrorMetadata> = {
  forbidden_repository: { retryable: false, nextAction: 'escalate', retryAfter: 'forbidden' },
  api_environments_disabled: { retryable: false, nextAction: 'escalate', retryAfter: 'forbidden' },
  toolset_disabled: { retryable: false, nextAction: 'escalate', retryAfter: 'forbidden' },
  rate_limited: { retryable: true, nextAction: 'retry', retryAfter: 'required' },
  wait_capacity: { retryable: true, nextAction: 'retry', retryAfter: 'required' },
  env_not_found: {
    retryable: false,
    nextAction: 'fix_input',
    retryAfter: 'forbidden',
    detailsKind: 'env_not_found',
  },
  repo_not_onboarded: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  site_not_found: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  logs_not_found: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  service_not_found: {
    retryable: false,
    nextAction: 'fix_input',
    retryAfter: 'forbidden',
    detailsKind: 'valid_services',
  },
  job_not_found: {
    retryable: false,
    nextAction: 'fix_input',
    retryAfter: 'forbidden',
    detailsKind: 'available_jobs',
  },
  env_ambiguous: {
    retryable: false,
    nextAction: 'fix_input',
    retryAfter: 'forbidden',
    detailsKind: 'ambiguous_environment',
  },
  invalid_body: {
    retryable: false,
    nextAction: 'fix_input',
    retryAfter: 'forbidden',
    detailsKind: 'validation',
  },
  invalid_cursor: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  name_conflict: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  idempotency_conflict: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  expiry_conflict: {
    retryable: false,
    nextAction: 'fix_input',
    retryAfter: 'forbidden',
    detailsKind: 'current_expiry',
  },
  environment_replaced: {
    retryable: false,
    nextAction: 'fix_input',
    retryAfter: 'forbidden',
    detailsKind: 'environment_replacement',
  },
  env_tearing_down: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  deploy_disabled: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  env_static_protected: { retryable: false, nextAction: 'none', retryAfter: 'forbidden' },
  env_pr_protected: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  pr_environment_not_extendable: { retryable: false, nextAction: 'none', retryAfter: 'forbidden' },
  forbidden_role: { retryable: false, nextAction: 'escalate', retryAfter: 'forbidden' },
  config_invalid: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  auto_track_pinned_source: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  invalid_field_for_trigger: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  override_not_allowed: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  confirm_token_invalid: { retryable: false, nextAction: 'confirm', retryAfter: 'forbidden' },
  confirm_token_expired: { retryable: false, nextAction: 'confirm', retryAfter: 'forbidden' },
  unsupported_log_source: { retryable: false, nextAction: 'fix_input', retryAfter: 'forbidden' },
  upstream_unavailable: { retryable: true, nextAction: 'retry', retryAfter: 'optional' },
  internal_error: { retryable: false, nextAction: 'escalate', retryAfter: 'forbidden' },
};

const closed = (properties: Record<string, Record<string, unknown>>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const ERROR_DETAILS_SCHEMAS: Record<McpErrorDetailsKind, Record<string, unknown>> = {
  env_not_found: closed(
    {
      kind: { const: 'destroyed' },
      destroyedAt: { type: 'string', format: 'date-time' },
    },
    ['kind', 'destroyedAt']
  ),
  valid_services: closed(
    {
      validServices: {
        type: 'array',
        minItems: 0,
        maxItems: 100,
        uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    ['validServices']
  ),
  available_jobs: closed(
    {
      availableJobs: {
        type: 'array',
        minItems: 0,
        maxItems: 100,
        uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 253 },
      },
    },
    ['availableJobs']
  ),
  validation: closed(
    {
      issues: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: closed(
          {
            path: { type: 'string', minLength: 1, maxLength: 500 },
            message: { type: 'string', minLength: 1, maxLength: 500 },
          },
          ['path', 'message']
        ),
      },
    },
    ['issues']
  ),
  current_expiry: closed(
    {
      currentExpiresAt: { type: 'string', format: 'date-time' },
    },
    ['currentExpiresAt']
  ),
  environment_replacement: closed(
    {
      replacementExists: { type: 'boolean' },
    },
    ['replacementExists']
  ),
  ambiguous_environment: closed(
    {
      environments: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: closed(
          {
            environmentConfigId: { type: 'integer', minimum: 1 },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            isDefault: { type: 'boolean' },
          },
          ['environmentConfigId', 'name', 'isDefault']
        ),
      },
    },
    ['environments']
  ),
};

const ERROR_DETAILS_VALIDATORS = Object.fromEntries(
  Object.entries(ERROR_DETAILS_SCHEMAS).map(([kind, schema]) => [kind, compileMcpJsonValidator<McpJsonObject>(schema)])
) as Record<McpErrorDetailsKind, ReturnType<typeof compileMcpJsonValidator<McpJsonObject>>>;

export interface McpExecutionErrorEnvelope {
  error: {
    code: McpExecutionErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    nextAction: McpNextAction;
    details?: McpJsonObject;
    requestId: string;
  };
}

export class McpExecutionError extends Error {
  readonly code: McpExecutionErrorCode;
  readonly details?: McpJsonObject;
  readonly retryAfterSeconds?: number;

  constructor(
    code: McpExecutionErrorCode,
    message: string,
    options: { details?: McpJsonObject; retryAfterSeconds?: number } = {}
  ) {
    super(message);
    this.name = 'McpExecutionError';
    this.code = code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function toExecutionErrorEnvelope(error: McpExecutionError, requestId: string): McpExecutionErrorEnvelope {
  const metadata = MCP_ERROR_METADATA[error.code];
  const message = error.message.trim();
  if (message.length < 1 || message.length > 2000) {
    throw new Error(`Invalid MCP error message length for ${error.code}`);
  }
  if (!/^[\x20-\x7e]{1,128}$/.test(requestId)) {
    throw new Error('MCP requestId must be 1-128 visible ASCII characters');
  }

  const retryAfterSeconds =
    error.retryAfterSeconds === undefined
      ? undefined
      : Math.min(3600, Math.max(1, Math.trunc(error.retryAfterSeconds)));
  if (
    (metadata.retryAfter === 'forbidden' && retryAfterSeconds !== undefined) ||
    (metadata.retryAfter === 'required' && retryAfterSeconds === undefined) ||
    (!metadata.retryable && retryAfterSeconds !== undefined)
  ) {
    throw new Error(`Invalid retryAfterSeconds for ${error.code}`);
  }
  const detailsAreOptional = error.code === 'env_not_found';
  if (
    (!metadata.detailsKind && Boolean(error.details)) ||
    (metadata.detailsKind && !error.details && !detailsAreOptional)
  ) {
    throw new Error(`Invalid details presence for ${error.code}`);
  }
  if (metadata.detailsKind && error.details) {
    const validateDetails = ERROR_DETAILS_VALIDATORS[metadata.detailsKind];
    if (!validateDetails(error.details)) {
      throw new Error(
        `Invalid ${metadata.detailsKind} details for ${error.code}: ${schemaValidationSummary(validateDetails.errors)}`
      );
    }
  }

  return {
    error: {
      code: error.code,
      message,
      retryable: metadata.retryable,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      nextAction: metadata.nextAction,
      ...(error.details ? { details: error.details } : {}),
      requestId,
    },
  };
}
