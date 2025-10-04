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

export class AIDebugError extends Error {
  code: string;
  statusCode: number;
  details?: Record<string, any>;

  constructor(code: string, message: string, statusCode: number, details?: Record<string, any>) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.name = 'AIDebugError';
  }
}

export const AI_DEBUG_ERRORS = {
  BUILD_NOT_FOUND: {
    code: 'BUILD_NOT_FOUND',
    statusCode: 404,
    message: 'Build not found or has been deleted',
  },
  CONTEXT_GATHERING_FAILED: {
    code: 'CONTEXT_GATHERING_FAILED',
    statusCode: 500,
    message: 'Failed to gather debugging context from Kubernetes',
  },
  LLM_API_ERROR: {
    code: 'LLM_API_ERROR',
    statusCode: 503,
    message: 'AI service temporarily unavailable',
  },
  LLM_INIT_ERROR: {
    code: 'LLM_INIT_ERROR',
    statusCode: 503,
    message: 'Failed to initialize AI service. Check API key configuration.',
  },
  CONVERSATION_ERROR: {
    code: 'CONVERSATION_ERROR',
    statusCode: 500,
    message: 'Failed to manage conversation state',
  },
  AI_DEBUG_DISABLED: {
    code: 'AI_DEBUG_DISABLED',
    statusCode: 503,
    message: 'AI Debugging is not enabled in configuration',
  },
  INVALID_REQUEST: {
    code: 'INVALID_REQUEST',
    statusCode: 400,
    message: 'Invalid request parameters',
  },
};
