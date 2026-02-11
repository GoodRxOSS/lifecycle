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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardHeader, CardBody, Chip, Divider, Skeleton } from '@heroui/react';
import { parseStructuredResponse, extractJsonContent } from './utils';
import { MarkdownRenderer } from './MarkdownRenderer';
import { StructuredResponse } from './StructuredResponse';
import { ActivityPanel } from './ActivityPanel';
import type { DebugMessage, ActivityLog, EvidenceItem, ServiceInvestigationResult, StructuredDebugResponse, DebugToolData, DebugContextData, DebugMetrics } from './types';
import { useProgressiveJson } from './hooks/useProgressiveJson';
import { XrayContextPanel } from './XrayPanel';

interface RepositoryContext {
  owner: string;
  repo: string;
  sha: string;
}

interface MessageBubbleProps {
  message: DebugMessage;
  isStreaming?: boolean;
  streamingContent?: string;
  activityLogs?: ActivityLog[];
  evidenceItems?: EvidenceItem[];
  onAutoFix: (service: ServiceInvestigationResult) => void;
  loading: boolean;
  repositoryContext?: RepositoryContext;
  xrayMode?: boolean;
  debugContext?: DebugContextData | null;
  debugMetrics?: DebugMetrics | null;
  debugToolDataMap?: Map<string, DebugToolData>;
}

function renderSimpleFallbackService(service: any) {
  return (
    <Card className="border border-gray-200">
      <CardHeader className="pb-2">
        <h4 className="text-base font-semibold text-gray-800">{service.serviceName}</h4>
      </CardHeader>
      <CardBody className="pt-2">
        {service.issue && (
          <p className="text-sm text-gray-700 mb-2">{service.issue}</p>
        )}
        {service.suggestedFix && (
          <div className="bg-success-50 border border-success-200 p-3 rounded-lg mt-2">
            <p className="text-sm text-success-700">{service.suggestedFix}</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function renderFixesAppliedBanner() {
  return (
    <Card className="mb-4 bg-success-50 border-2 border-success">
      <CardBody className="py-3">
        <div className="flex items-center gap-3">
          <Chip color="success" variant="solid" size="lg" className="font-bold">
            Success
          </Chip>
          <div className="flex-1">
            <p className="text-sm font-bold text-success-800">Fixes Applied Successfully!</p>
            <p className="text-xs text-success-700">Changes have been automatically committed to your repository</p>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function renderMessage(
  content: string,
  isStreaming: boolean,
  onAutoFix: (service: ServiceInvestigationResult) => void,
  loading: boolean,
  repositoryContext?: RepositoryContext,
  progressiveResult?: { parsed: Partial<StructuredDebugResponse> | null; isStructuredStream: boolean },
  evidenceItems?: EvidenceItem[],
  onHighlightActivity?: (toolCallId: string) => void
) {
  let derivedRepoContext: RepositoryContext | undefined;

  if (!isStreaming) {
    const structured = parseStructuredResponse(content);
    if (structured) {
      if (structured.repository?.sha) {
        derivedRepoContext = {
          owner: structured.repository.owner,
          repo: structured.repository.name,
          sha: structured.repository.sha,
        };
      }
      return <StructuredResponse structured={structured} onAutoFix={onAutoFix} loading={loading} evidence={evidenceItems} onHighlightActivity={onHighlightActivity} />;
    }
  }

  if (isStreaming && progressiveResult?.isStructuredStream && progressiveResult.parsed) {
    return (
      <StructuredResponse
        structured={progressiveResult.parsed as StructuredDebugResponse}
        onAutoFix={onAutoFix}
        loading={loading}
        partial={true}
        evidence={evidenceItems}
        onHighlightActivity={onHighlightActivity}
      />
    );
  }

  if (isStreaming && (content.trim().startsWith('{') || content.includes('```json') || content.includes('{"type"')) && content.includes('"type"')) {
    return (
      <Card className="bg-gray-50 border border-gray-200">
        <CardBody className="p-3">
          <Skeleton className="h-4 w-3/4 rounded-lg mb-2" />
          <Skeleton className="h-3 w-1/2 rounded-lg" />
        </CardBody>
      </Card>
    );
  }

  const extractedJson = !isStreaming ? extractJsonContent(content) : '';
  if (!isStreaming && extractedJson.startsWith('{')) {
    try {
      const json = JSON.parse(extractedJson);
      if (json.type === 'investigation_complete' && json.services) {
        return (
          <div className="space-y-4">
            {json.fixesApplied && renderFixesAppliedBanner()}
            {json.summary && (
              <p className="text-sm text-gray-700 leading-relaxed mb-6">{json.summary}</p>
            )}
            <div className="space-y-4">
              {json.services.map((service: any, idx: number) => (
                <div key={idx}>
                  {renderSimpleFallbackService(service)}
                </div>
              ))}
            </div>
          </div>
        );
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // Try to recover truncated JSON by finding valid closing points
        const tryRecovery = (json: string): any => {
          // Try multiple recovery strategies
          const strategies = [
            // Strategy 1: Find last complete object, close arrays and root
            () => {
              const lastBrace = json.lastIndexOf('}');
              if (lastBrace > 0) {
                let recovered = json.substring(0, lastBrace + 1);
                // Count unclosed brackets
                const openBrackets = (recovered.match(/\[/g) || []).length;
                const closeBrackets = (recovered.match(/\]/g) || []).length;
                const openBraces = (recovered.match(/\{/g) || []).length;
                const closeBraces = (recovered.match(/\}/g) || []).length;
                // Close unclosed arrays and objects
                recovered += ']'.repeat(Math.max(0, openBrackets - closeBrackets));
                recovered += '}'.repeat(Math.max(0, openBraces - closeBraces));
                return JSON.parse(recovered);
              }
              return null;
            },
            // Strategy 2: Original simple recovery
            () => {
              let recovered = json;
              const lastBrace = recovered.lastIndexOf('}');
              if (lastBrace > 0) {
                recovered = recovered.substring(0, lastBrace + 1);
                if (!recovered.includes(']')) {
                  recovered += '\n  ]\n}';
                } else if (!recovered.endsWith('}')) {
                  recovered += '\n}';
                }
                return JSON.parse(recovered);
              }
              return null;
            },
          ];

          for (const strategy of strategies) {
            try {
              const result = strategy();
              if (result?.type === 'investigation_complete' && result.services) {
                return result;
              }
            } catch {
              // Try next strategy
            }
          }
          return null;
        };

        const recovered = tryRecovery(extractedJson);
        if (recovered) {
          return (
            <div className="space-y-4">
              <div className="bg-warning-50 border border-warning p-3 rounded-lg">
                <p className="text-xs text-warning-800">Response was truncated - showing partial results</p>
              </div>
              {recovered.fixesApplied && renderFixesAppliedBanner()}
              {recovered.summary && (
                <p className="text-sm text-gray-700 leading-relaxed mb-6">{recovered.summary}</p>
              )}
              <div className="space-y-4">
                {recovered.services.map((service: any, idx: number) => (
                  <div key={idx}>
                    {renderSimpleFallbackService(service)}
                  </div>
                ))}
              </div>
            </div>
          );
        }
      }

      if (extractedJson.startsWith('{')) {
        return (
          <div className="bg-danger-50 border border-danger p-4 rounded-lg">
            <h5 className="text-sm font-semibold text-danger mb-2">Malformed Response</h5>
            <p className="text-xs text-gray-600 mb-2">
              The response appears to be truncated or malformed. Showing raw content:
            </p>
            <div className="bg-white border border-gray-200 p-3 rounded-lg">
              <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs text-gray-700 max-h-96 overflow-y-auto">
                {content.trim()}
              </pre>
            </div>
          </div>
        );
      }
    }
  }

  return <MarkdownRenderer content={content} repositoryContext={derivedRepoContext || repositoryContext} />;
}

export const MessageBubble = React.memo(function MessageBubble({ message, isStreaming, streamingContent, activityLogs, evidenceItems, onAutoFix, loading, repositoryContext, xrayMode, debugContext, debugMetrics, debugToolDataMap }: MessageBubbleProps) {
  const [highlightedToolCallId, setHighlightedToolCallId] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHighlightActivity = useCallback((toolCallId: string) => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    setHighlightedToolCallId(toolCallId);
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedToolCallId(null);
      highlightTimeoutRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  const progressiveResult = useProgressiveJson(
    isStreaming ? (streamingContent || '') : '',
    !!isStreaming
  );

  if (isStreaming) {
    const content = streamingContent || '';
    return (
      <div className="message-fade-in mb-6 w-[80%]">
        <div className="ai-message-content">
          {xrayMode && debugContext && (
            <XrayContextPanel debugContext={debugContext} debugMetrics={debugMetrics} />
          )}
          {activityLogs && activityLogs.length > 0 && (
            <ActivityPanel activities={activityLogs} highlightedToolCallId={highlightedToolCallId} xrayMode={xrayMode} debugToolDataMap={debugToolDataMap} />
          )}
          {renderMessage(content, true, onAutoFix, loading, repositoryContext, progressiveResult, evidenceItems, handleHighlightActivity)}
          <span className="typing-cursor">&#x258A;</span>
        </div>
      </div>
    );
  }

  if (message.role === 'user' && message.isSystemAction) {
    return (
      <div className="message-fade-in flex items-center gap-4 mb-8">
        <Divider className="flex-1" />
        <Chip size="sm" variant="flat" color="success" className="font-semibold">
          Aplying suggested fix
        </Chip>
        <Divider className="flex-1" />
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className={`message-fade-in mb-6 flex justify-end ${message.failed ? 'opacity-70' : ''}`}>
        <Card
          className="max-w-[70%] shadow-md hover:shadow-lg transition-shadow duration-200"
          style={{
            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
          }}
        >
          <CardBody className="px-5 py-3">
            <div className="user-message-content">
              <div className="text-white font-medium">{message.content}</div>
            </div>
            {message.failed && (
              <div className="mt-1 text-xs text-red-400 flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path fillRule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                </svg>
                Failed to send
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    );
  }

  const effectiveDebugContext = debugContext || message.debugContext || null;
  const effectiveDebugMetrics = debugMetrics || message.debugMetrics || null;
  const effectiveDebugToolDataMap = (debugToolDataMap && debugToolDataMap.size > 0) ? debugToolDataMap : (() => {
    if (!message.debugToolData || message.debugToolData.length === 0) return undefined;
    const map = new Map<string, DebugToolData>();
    for (const td of message.debugToolData) {
      map.set(td.toolCallId, td);
    }
    return map;
  })();

  return (
    <div className="message-fade-in mb-6 w-[80%]">
      <div className="ai-message-content">
        {xrayMode && effectiveDebugContext && (
          <XrayContextPanel debugContext={effectiveDebugContext} debugMetrics={effectiveDebugMetrics} />
        )}
        {message.activityHistory && (
          <ActivityPanel activities={message.activityHistory} totalInvestigationTimeMs={message.totalInvestigationTimeMs} highlightedToolCallId={highlightedToolCallId} xrayMode={xrayMode} debugToolDataMap={effectiveDebugToolDataMap} />
        )}
        {renderMessage(message.content, false, onAutoFix, loading, repositoryContext, undefined, message.evidenceItems, handleHighlightActivity)}
        {message.stopped && <div className="mt-2 text-xs text-gray-400 italic">Generation stopped</div>}
      </div>
    </div>
  );
});
