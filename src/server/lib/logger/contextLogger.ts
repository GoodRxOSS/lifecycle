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
import rootLogger from '../logger';
import { getLogContext } from './context';
import type { LogContext } from './types';

function getTraceContext(): { traceId?: string; spanId?: string } {
  if (typeof tracer?.scope !== 'function') return {};
  const span = tracer.scope()?.active();
  if (!span) return {};
  const context = span.context();
  return {
    traceId: context.toTraceId(),
    spanId: context.toSpanId(),
  };
}

export function getLogger(extra?: Partial<LogContext> & Record<string, unknown>) {
  const asyncContext = getLogContext();
  const traceContext = getTraceContext();

  const fullContext: Record<string, unknown> = {
    correlationId: asyncContext.correlationId,
    buildUuid: asyncContext.buildUuid,
    deployUuid: asyncContext.deployUuid,
    serviceName: asyncContext.serviceName,
    sender: asyncContext.sender,
    stage: extra?.stage || asyncContext.stage,
    repo: asyncContext.repo,
    pr: asyncContext.pr,
    branch: asyncContext.branch,
    'dd.trace_id': traceContext.traceId,
    'dd.span_id': traceContext.spanId,
    ...extra,
  };

  const cleanContext = Object.fromEntries(Object.entries(fullContext).filter(([_, v]) => v !== undefined));

  return rootLogger.child(cleanContext);
}
