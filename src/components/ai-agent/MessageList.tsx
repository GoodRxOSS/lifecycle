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

import React, { useEffect, useRef, useState } from 'react';
import { Spinner, Button } from '@heroui/react';
import { MessageBubble } from './MessageBubble';
import { ActivityPanel } from './ActivityPanel';
import type { DebugMessage, ActivityLog, EvidenceItem, ServiceInvestigationResult } from './types';

interface MessageListProps {
  messages: DebugMessage[];
  streaming: boolean;
  streamingContent: string;
  activityLogs: ActivityLog[];
  evidenceItems: EvidenceItem[];
  loading: boolean;
  onAutoFix: (service: ServiceInvestigationResult) => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
  onAtBottomChange?: (isAtBottom: boolean) => void;
  followUpSuggestions?: string[];
  onSelectSuggestion?: (suggestion: string) => void;
}

export function MessageList({
  messages,
  streaming,
  streamingContent,
  activityLogs,
  evidenceItems,
  loading,
  onAutoFix,
  messagesEndRef,
  scrollContainerRef,
  onAtBottomChange,
  followUpSuggestions,
  onSelectSuggestion,
}: MessageListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [, setLocalIsAtBottom] = useState(true);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef?.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setLocalIsAtBottom(entry.isIntersecting);
        onAtBottomChange?.(entry.isIntersecting);
      },
      { root: container || null, threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollContainerRef, onAtBottomChange]);

  return (
    <div className="max-w-5xl mx-auto w-full px-8 pb-32">
      {messages.map((msg) => (
        <MessageBubble
          key={`${msg.role}-${msg.timestamp}`}
          message={msg}
          onAutoFix={onAutoFix}
          loading={loading}
        />
      ))}

      {streaming && streamingContent && (
        <MessageBubble
          message={{ role: 'assistant', content: '', timestamp: Date.now() }}
          isStreaming={true}
          streamingContent={streamingContent}
          activityLogs={activityLogs}
          evidenceItems={evidenceItems}
          onAutoFix={onAutoFix}
          loading={loading}
        />
      )}

      {loading && !streamingContent && (
        <div className="mb-6 w-[80%]">
          <div className="flex items-center gap-4 min-h-[48px] mb-3">
            <Spinner size="sm" color="primary" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-gray-700 block overflow-hidden overflow-ellipsis" style={{ minHeight: '20px' }}>
                {activityLogs.length > 0
                  ? activityLogs[activityLogs.length - 1].message.length > 50
                    ? activityLogs[activityLogs.length - 1].message.substring(0, 50) + '...'
                    : activityLogs[activityLogs.length - 1].message
                  : 'Thinking...'}
              </div>
              <span className="text-xs text-gray-500">Working on your request</span>
            </div>
          </div>
          {activityLogs.length > 0 && (
            <div className="ai-message-content">
              <ActivityPanel activities={activityLogs} />
            </div>
          )}
        </div>
      )}

      {followUpSuggestions && followUpSuggestions.length > 0 && !loading && !streaming && (
        <div className="mb-4">
          <div className="flex flex-wrap gap-2">
            {followUpSuggestions.map((suggestion, idx) => (
              <Button
                key={idx}
                size="sm"
                variant="bordered"
                color="primary"
                className="text-xs font-normal"
                onClick={() => onSelectSuggestion?.(suggestion)}
                isDisabled={loading}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div ref={sentinelRef} className="h-1" />
      <div ref={messagesEndRef} />
    </div>
  );
}
