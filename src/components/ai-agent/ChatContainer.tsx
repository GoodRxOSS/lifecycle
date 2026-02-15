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

import React, { useRef, useCallback, useState, useMemo } from 'react';
import { Card, CardHeader, CardBody, Button, Spinner } from '@heroui/react';
import { useChat } from './hooks/useChat';
import { useChatModels } from './hooks/useChatModels';
import { useXrayMode } from './hooks/useXrayMode';
import { ModelSelector } from './ModelSelector';
import { ErrorBanner } from './ErrorBanner';
import { ChatInput } from './ChatInput';
import { SuggestedPrompts } from './SuggestedPrompts';
import { MessageList } from './MessageList';
import { globalStyles } from './styles';
import { getFollowUpSuggestions, computeCost, formatCost } from './utils';
import type { ServiceInvestigationResult } from './types';

interface ChatContainerProps {
  buildUuid: string;
}

export function ChatContainer({ buildUuid }: ChatContainerProps) {
  const { availableModels, selectedModel, handleModelChange } = useChatModels();
  const { xrayMode, handleLabelClick } = useXrayMode();
  const {
    messages,
    input,
    setInput,
    loading,
    historyLoading,
    streaming,
    streamingContent,
    activityLogs,
    evidenceItems,
    error,
    setError,
    mounted,
    sendMessage,
    handleSubmit,
    handleClearHistory,
    handleAutoFix,
    autoResizeTextarea,
    stopGeneration,
    retryLastMessage,
    setIsAtBottom,
    scrollToBottom,
    messagesEndRef,
    inputRef,
    debugContext,
    debugMetrics,
    debugToolDataMapRef,
  } = useChat({ buildUuid, selectedModel });

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setShowJumpToBottom(!atBottom);
    setIsAtBottom(atBottom);
  }, [setIsAtBottom]);

  const stableHandleAutoFix = useCallback(
    (service: ServiceInvestigationResult) => handleAutoFix(service),
    [handleAutoFix]
  );

  const followUpSuggestions = useMemo(
    () => (!loading && !streaming ? getFollowUpSuggestions(messages) : []),
    [messages, loading, streaming]
  );

  const sessionTotalCost = useMemo(() => {
    let total = 0;
    let hasCost = false;
    for (const msg of messages) {
      if (msg.debugMetrics?.inputTokens != null) {
        const cost = computeCost(
          msg.debugMetrics.inputTokens,
          msg.debugMetrics.outputTokens || 0,
          msg.debugMetrics.inputCostPerMillion,
          msg.debugMetrics.outputCostPerMillion
        );
        if (cost != null) {
          total += cost;
          hasCost = true;
        }
      }
    }
    return hasCost ? formatCost(total) : null;
  }, [messages]);

  if (!mounted) {
    return (
      <div className="flex items-center justify-center h-screen bg-white">
        <Spinner size="lg" label="Loading..." color="primary" />
      </div>
    );
  }

  return (
    <Card className="h-screen flex flex-col overflow-hidden shadow-none border-0 rounded-none bg-white">
      <CardHeader className="flex justify-between items-center border-b-2 border-gray-100 bg-gradient-to-r from-blue-50 via-purple-50 to-pink-50 px-6 py-4">
        <ModelSelector
          availableModels={availableModels}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          onClearHistory={handleClearHistory}
          loading={loading}
          hasMessages={messages.length > 0}
          onLabelClick={handleLabelClick}
          xrayMode={xrayMode}
          sessionTotalCost={sessionTotalCost}
        />
      </CardHeader>

      <ErrorBanner error={error} onRetry={retryLastMessage} onDismiss={() => setError(null)} />

      <CardBody className="flex-1 overflow-hidden p-0 bg-white shadow-none border-0">
        <div ref={scrollContainerRef} className="h-full overflow-y-auto p-8">
          {messages.length === 0 && !streaming && !historyLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="mb-8">
                <h3 className="text-2xl font-bold text-gray-800 mb-3">
                  Ask me anything about <span className="font-mono text-primary">{buildUuid}</span> environment
                </h3>
                <p className="text-sm text-gray-600 max-w-2xl leading-relaxed">
                  I can debug deployments, investigate pod issues, analyze logs, and fix configuration problems.
                </p>
              </div>

              <div className="w-full max-w-2xl mb-8">
                <ChatInput
                  buildUuid={buildUuid}
                  input={input}
                  onInputChange={setInput}
                  onSubmit={handleSubmit}
                  loading={loading}
                  streaming={streaming}
                  onStop={stopGeneration}
                  inputRef={inputRef}
                  autoResizeTextarea={autoResizeTextarea}
                />
              </div>

              <SuggestedPrompts
                onSelectPrompt={(q) => sendMessage(q)}
                loading={loading}
              />
            </div>
          ) : null}

          <MessageList
            messages={messages}
            streaming={streaming}
            streamingContent={streamingContent}
            activityLogs={activityLogs}
            evidenceItems={evidenceItems}
            loading={loading}
            onAutoFix={stableHandleAutoFix}
            messagesEndRef={messagesEndRef}
            scrollContainerRef={scrollContainerRef}
            onAtBottomChange={handleAtBottomChange}
            followUpSuggestions={followUpSuggestions}
            onSelectSuggestion={sendMessage}
            xrayMode={xrayMode}
            debugContext={debugContext}
            debugMetrics={debugMetrics}
            debugToolDataMap={debugToolDataMapRef.current}
          />

          {showJumpToBottom && (
            <div className="sticky bottom-4 flex justify-center pointer-events-none">
              <Button
                isIconOnly
                className="pointer-events-auto bg-white shadow-lg border border-gray-200 hover:bg-gray-50"
                radius="full"
                size="md"
                onClick={scrollToBottom}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-gray-600">
                  <path fillRule="evenodd" d="M12 3.75a.75.75 0 01.75.75v13.19l5.47-5.47a.75.75 0 111.06 1.06l-6.75 6.75a.75.75 0 01-1.06 0l-6.75-6.75a.75.75 0 111.06-1.06l5.47 5.47V4.5a.75.75 0 01.75-.75z" clipRule="evenodd" />
                </svg>
              </Button>
            </div>
          )}
        </div>
      </CardBody>

      {(messages.length > 0 || streaming) && (
        <div className="fixed bottom-0 left-0 right-0 px-8 pb-8 pt-8 z-10 bg-transparent">
          <div className="max-w-5xl mx-auto w-full">
            <ChatInput
              buildUuid={buildUuid}
              input={input}
              onInputChange={setInput}
              onSubmit={handleSubmit}
              loading={loading}
              streaming={streaming}
              onStop={stopGeneration}
              inputRef={inputRef}
              autoResizeTextarea={autoResizeTextarea}
            />
          </div>
        </div>
      )}

      {/* eslint-disable-next-line react/no-unknown-property */}
      <style jsx global>{globalStyles}</style>
    </Card>
  );
}
