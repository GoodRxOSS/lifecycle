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

import React, { useRef, useEffect } from 'react';
import { Accordion, AccordionItem, Chip, Spinner } from '@heroui/react';
import { formatDuration } from './utils';
import type { ActivityLog, DebugToolData } from './types';

interface ActivityPanelProps {
  activities: ActivityLog[];
  totalInvestigationTimeMs?: number;
  highlightedToolCallId?: string | null;
  xrayMode?: boolean;
  debugToolDataMap?: Map<string, DebugToolData>;
}

export function ActivityPanel({ activities, totalInvestigationTimeMs, highlightedToolCallId, xrayMode, debugToolDataMap }: ActivityPanelProps) {
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlightedToolCallId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [highlightedToolCallId]);

  if (!activities || activities.length === 0) return null;

  return (
    <div className="mb-3">
      <Accordion
        variant="light"
        className="px-0"
        itemClasses={{
          base: 'bg-gray-50/50 rounded',
          title: 'text-xs font-medium text-gray-500',
          trigger: 'px-2 py-1.5 hover:bg-gray-100/50 min-h-0 h-auto',
          content: 'px-0 pt-0 pb-0',
          indicator: 'text-gray-400',
        }}
      >
        <AccordionItem
          key="1"
          aria-label="Investigation"
          title={
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-500">Investigation</span>
              <Chip
                color="default"
                variant="flat"
                size="sm"
                className="bg-gray-200/70 text-gray-600 h-4 text-[10px] px-1.5"
              >
                {activities.length}
              </Chip>
              {totalInvestigationTimeMs !== undefined && totalInvestigationTimeMs > 0 && (
                <span className="text-[10px] text-gray-500 font-mono">
                  {formatDuration(totalInvestigationTimeMs)} total
                </span>
              )}
            </div>
          }
        >
          <div className="bg-gray-50/30 border-t border-gray-200 px-2 py-2 space-y-0.5">
            {activities.map((activity, idx) => {
              const totalDuration = activity.details?.totalDurationMs;

              const isCompleted = activity.status === 'completed';
              const isFailed = activity.status === 'failed';
              const isPending = activity.status === 'pending';

              const displayMessage = activity.message
                .replace(/^[\u2713]\s*/, '')
                .replace(/^Failed to\s*/i, '');

              const isHighlighted = highlightedToolCallId != null && highlightedToolCallId === activity.toolCallId;

              return (
                <div
                  key={idx}
                  data-tool-call-id={activity.toolCallId}
                  ref={isHighlighted ? highlightRef : undefined}
                >
                  <div
                    className={`flex items-center gap-2 py-1.5 px-2 rounded-md transition-colors ${
                      isHighlighted
                        ? 'bg-primary-50 ring-1 ring-primary-200'
                        : 'hover:bg-gray-100/50'
                    }`}
                  >
                    <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                      {isPending && <Spinner size="sm" classNames={{ wrapper: 'w-3 h-3' }} />}
                      {isCompleted && (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3.5 h-3.5 text-success"
                        >
                          <path
                            fillRule="evenodd"
                            d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                      {isFailed && (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3.5 h-3.5 text-danger"
                        >
                          <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                        </svg>
                      )}
                      {!isPending && !isCompleted && !isFailed && (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          className="w-3.5 h-3.5 text-gray-400"
                        >
                          <path
                            fillRule="evenodd"
                            d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm3.844-8.791a.75.75 0 0 0-1.188-.918l-3.7 4.79-1.649-1.833a.75.75 0 1 0-1.114 1.004l2.25 2.5a.75.75 0 0 0 1.15-.043l4.25-5.5Z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </div>

                    <span
                      className={`text-[11px] flex-1 leading-tight ${isFailed ? 'text-danger' : 'text-gray-600'}`}
                    >
                      {displayMessage}
                    </span>

                    {totalDuration !== undefined && totalDuration > 0 && (
                      <Chip
                        size="sm"
                        variant="flat"
                        className="h-4 text-[9px] px-1.5 min-w-0 bg-gray-100 text-gray-500"
                      >
                        {formatDuration(totalDuration)}
                      </Chip>
                    )}
                  </div>
                  {activity.resultPreview && isCompleted && (
                    <div className="text-[10px] text-gray-500 mt-0.5 pl-6 truncate leading-tight">
                      {activity.resultPreview}
                    </div>
                  )}
                  {xrayMode && activity.toolCallId && debugToolDataMap?.get(activity.toolCallId) && (() => {
                    const toolData = debugToolDataMap.get(activity.toolCallId)!;
                    return (
                      <div className="ml-6 mt-1 mb-1 border-l-2 border-amber-400 pl-2">
                        <details className="text-[10px]">
                          <summary className="text-amber-600 cursor-pointer select-none font-medium hover:text-amber-700">
                            INPUT: {toolData.toolName}
                          </summary>
                          <div className="mt-1 rounded bg-gray-900" style={{ maxHeight: 192, overflowY: 'auto' }}>
                            <pre className="p-2 text-green-300 text-[10px] font-mono whitespace-pre-wrap break-words m-0">
                              {JSON.stringify(toolData.toolArgs, null, 2)}
                            </pre>
                          </div>
                        </details>
                        {toolData.toolResult !== undefined && (
                          <details className="text-[10px] mt-1">
                            <summary className="text-amber-600 cursor-pointer select-none font-medium hover:text-amber-700">
                              OUTPUT{toolData.toolDurationMs ? ` (${toolData.toolDurationMs}ms)` : ''}
                            </summary>
                            <div className="mt-1 rounded bg-gray-900" style={{ maxHeight: 192, overflowY: 'auto' }}>
                              <pre className="p-2 text-cyan-300 text-[10px] font-mono whitespace-pre-wrap break-words m-0">
                                {JSON.stringify(toolData.toolResult, null, 2)}
                              </pre>
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
