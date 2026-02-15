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

import React from 'react';
import { Chip } from '@heroui/react';
import { formatDuration, computeCost, formatCost } from './utils';
import type { DebugContextData, DebugMetrics } from './types';

interface XrayContextPanelProps {
  debugContext: DebugContextData;
  debugMetrics?: DebugMetrics | null;
}

export function XrayContextPanel({ debugContext, debugMetrics }: XrayContextPanelProps) {
  return (
    <div className="mb-3 rounded border border-amber-300/50 bg-amber-50/50 xray-context-panel">
      <details>
        <summary className="px-3 py-2 text-xs font-medium text-amber-700 cursor-pointer select-none hover:bg-amber-100/50">
          System Prompt
          <span className="ml-2 text-[10px] text-amber-500 font-mono">
            {debugContext.systemPrompt.length.toLocaleString()} chars
          </span>
        </summary>
        <div className="border-t border-amber-200/50 px-3 py-2" style={{ maxHeight: 400, overflowY: 'auto' }}>
          <pre className="text-[11px] text-gray-700 whitespace-pre-wrap break-words font-mono leading-relaxed m-0">
            {debugContext.systemPrompt}
          </pre>
        </div>
      </details>

      <div className="border-t border-amber-200/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="flat" className="h-5 text-[10px] bg-amber-100 text-amber-700">
            {debugContext.provider}
          </Chip>
          <Chip size="sm" variant="flat" className="h-5 text-[10px] bg-amber-100 text-amber-700">
            {debugContext.modelId}
          </Chip>
          {debugContext.maskingStats && (
            <span className="text-[10px] text-amber-600 font-mono">
              masking: {debugContext.maskingStats.maskedParts} parts, saved {debugContext.maskingStats.savedTokens} tokens
            </span>
          )}
        </div>
      </div>

      {debugMetrics && (
        <div className="border-t border-amber-200/50 px-3 py-2">
          <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-amber-600">
            <span>iterations: {debugMetrics.iterations}</span>
            <span>tool calls: {debugMetrics.totalToolCalls}</span>
            <span>duration: {formatDuration(debugMetrics.totalDurationMs)}</span>
            {debugMetrics.inputTokens != null && (
              <span>tokens: {(debugMetrics.inputTokens + (debugMetrics.outputTokens || 0)).toLocaleString()} ({debugMetrics.inputTokens.toLocaleString()} in / {(debugMetrics.outputTokens || 0).toLocaleString()} out)</span>
            )}
            {debugMetrics.inputTokens != null && (() => {
              const cost = computeCost(
                debugMetrics.inputTokens!,
                debugMetrics.outputTokens || 0,
                debugMetrics.inputCostPerMillion,
                debugMetrics.outputCostPerMillion
              );
              return cost != null ? <span>cost: {formatCost(cost)}</span> : null;
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
