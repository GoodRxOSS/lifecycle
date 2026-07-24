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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AsyncLocalStorage } = require('async_hooks') as {
  AsyncLocalStorage: new <T>() => {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  };
};
import type { LogContext, JobDataWithContext } from './types';
import tracer from 'dd-trace';

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

export function getLogContext(): Partial<LogContext> {
  return asyncLocalStorage.getStore() || {};
}

type ContextWithTrace = Partial<LogContext> & { _ddTraceContext?: Record<string, string> };

export function withLogContext<T>(context: ContextWithTrace, fn: () => T | Promise<T>): T | Promise<T> {
  const parentContext = getLogContext();
  const mergedContext: LogContext = {
    ...parentContext,
    ...context,
    correlationId: context.correlationId || parentContext.correlationId || 'unknown',
  };

  const runWithContext = () => asyncLocalStorage.run(mergedContext, fn);

  if (
    context._ddTraceContext &&
    Object.keys(context._ddTraceContext).length > 0 &&
    typeof tracer?.scope === 'function'
  ) {
    const parentSpanContext = tracer.extract('text_map', context._ddTraceContext);
    if (parentSpanContext) {
      const span = tracer.startSpan('queue.process', { childOf: parentSpanContext });
      span.setTag('correlationId', mergedContext.correlationId);
      if (mergedContext.buildUuid) span.setTag('buildUuid', mergedContext.buildUuid);
      if (mergedContext.deployUuid) span.setTag('deployUuid', mergedContext.deployUuid);

      return tracer.scope().activate(span, () => {
        const result = runWithContext();
        if (result instanceof Promise) {
          return result.finally(() => span.finish()) as T | Promise<T>;
        }
        span.finish();
        return result;
      });
    }
  }

  return runWithContext();
}

export function updateLogContext(updates: Partial<LogContext>): void {
  const current = asyncLocalStorage.getStore();
  if (current) {
    Object.assign(current, updates);
  }
}

export function extractContextForQueue(): JobDataWithContext {
  const ctx = getLogContext();

  let traceContext: Record<string, string> | undefined;
  if (typeof tracer?.scope === 'function') {
    const activeSpan = tracer.scope().active();
    if (activeSpan) {
      traceContext = {};
      tracer.inject(activeSpan, 'text_map', traceContext);
    }
  }

  return {
    correlationId: ctx.correlationId,
    buildUuid: ctx.buildUuid,
    deployUuid: ctx.deployUuid,
    serviceName: ctx.serviceName,
    sender: ctx.sender,
    repo: ctx.repo,
    pr: ctx.pr,
    branch: ctx.branch,
    sha: ctx.sha,
    _ddTraceContext: traceContext,
  };
}
