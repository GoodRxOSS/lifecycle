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

import tracer from 'dd-trace';
import { getLogContext } from './context';

export interface SpanOptions {
  resource?: string;
  tags?: Record<string, string | number | boolean>;
}

export async function withSpan<T>(operationName: string, fn: () => Promise<T>, options: SpanOptions = {}): Promise<T> {
  if (typeof tracer?.trace !== 'function') {
    return fn();
  }

  const context = getLogContext();

  return tracer.trace(
    operationName,
    {
      resource: options.resource,
      tags: {
        'lifecycle.correlation_id': context.correlationId,
        'lifecycle.build_uuid': context.buildUuid,
        'lifecycle.deploy_uuid': context.deployUuid,
        'lifecycle.repo': context.repo,
        'lifecycle.pr': context.pr,
        ...options.tags,
      },
    },
    async (span) => {
      try {
        const result = await fn();
        span?.setTag('lifecycle.success', true);
        return result;
      } catch (error) {
        span?.setTag('error', true);
        span?.setTag('lifecycle.success', false);
        span?.setTag('error.message', error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  );
}
