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

import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  DebugMessage,
  ActivityLog,
  EvidenceItem,
  ModelOption,
  ServiceInvestigationResult,
  DebugToolData,
  DebugContextData,
  DebugMetrics,
} from '../types';
import { getApiPaths, fetchApi } from '../config';

export interface ChatError {
  userMessage: string;
  category: 'rate-limited' | 'transient' | 'deterministic' | 'ambiguous';
  suggestedAction: 'retry' | 'switch-model' | 'check-config' | null;
  retryAfter: number | null;
  modelName: string;
}

interface UseChatOptions {
  buildUuid: string;
  selectedModel: ModelOption | null;
}

export function useChat({ buildUuid, selectedModel }: UseChatOptions) {
  const [mounted, setMounted] = useState(false);
  const [messages, setMessages] = useState<DebugMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [evidenceItems, setEvidenceItems] = useState<EvidenceItem[]>([]);
  const [error, setError] = useState<ChatError | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [_failedMessage, setFailedMessage] = useState<string | null>(null);
  const [debugContext, setDebugContext] = useState<DebugContextData | null>(null);
  const [debugMetrics, setDebugMetrics] = useState<DebugMetrics | null>(null);
  const debugToolDataMapRef = useRef<Map<string, DebugToolData>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isAtBottomRef = useRef(true);
  const bufferRef = useRef('');
  const rafIdRef = useRef<number | null>(null);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushBuffer = useCallback(() => {
    rafIdRef.current = null;
    setStreamingContent(bufferRef.current);
  }, []);

  const loadConversationHistory = async () => {
    setHistoryLoading(true);
    try {
      const paths = getApiPaths();
      const messagesUrl = paths.messages(buildUuid);
      const data = await fetchApi<{ messages: DebugMessage[]; lastActivity?: number }>(messagesUrl);
      setMessages(data.messages || []);
    } catch (error) {
      console.log('No previous conversation found');
    } finally {
      setHistoryLoading(false);
    }
  };

  const clearConversation = async () => {
    try {
      const paths = getApiPaths();
      const sessionUrl = paths.session(buildUuid);
      await fetch(sessionUrl, { method: 'DELETE' });
    } catch (error) {
      console.error('Failed to clear conversation:', error);
    }
  };

  const sendMessage = async (
    message: string,
    options: { isSystemAction?: boolean; mode?: 'investigate' | 'fix' } = {}
  ) => {
    if (!message.trim()) return;
    const { isSystemAction = false, mode } = options;

    setInput('');
    setLoading(true);
    setStreaming(true);
    setStreamingContent('');
    setActivityLogs([]);
    setEvidenceItems([]);
    setDebugContext(null);
    setDebugMetrics(null);
    debugToolDataMapRef.current = new Map();
    bufferRef.current = '';
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setError(null);
    if (autoRetryTimerRef.current !== null) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }

    setMessages((prev) => [...prev, { role: 'user', content: message, timestamp: Date.now(), isSystemAction }]);

    const requestBody: any = { buildUuid, message, isSystemAction };
    if (mode) {
      requestBody.mode = mode;
    }
    if (selectedModel) {
      requestBody.provider = selectedModel.provider;
      requestBody.modelId = selectedModel.modelId;
    }
    let accumulatedContent = '';
    const collectedActivities: ActivityLog[] = [];
    const collectedEvidence: EvidenceItem[] = [];
    let localDebugContext: DebugContextData | null = null;
    let localDebugMetrics: DebugMetrics | null = null;
    let receivedCompleteJson = false;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const paths = getApiPaths();
      const chatUrl = typeof paths.chat === 'function' ? paths.chat(buildUuid) : paths.chat;
      const response = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'tool_call') {
                collectedActivities.push({
                  type: 'tool_call',
                  message: data.message,
                  status: 'pending',
                  toolCallId: data.toolCallId,
                });
                setActivityLogs([...collectedActivities]);
              } else if (data.type === 'processing') {
                const resultMessage = data.message.replace(/^[✓]\s*/, '').replace(/^Failed to\s*/i, '');

                const matchingIndex = collectedActivities.findIndex(
                  (a) =>
                    a.status === 'pending' &&
                    ((data.toolCallId && a.toolCallId && data.toolCallId === a.toolCallId) ||
                      a.message === resultMessage ||
                      a.message.toLowerCase() === resultMessage.toLowerCase() ||
                      resultMessage.toLowerCase().includes(a.message.toLowerCase()))
                );

                if (matchingIndex !== -1) {
                  collectedActivities[matchingIndex] = {
                    ...collectedActivities[matchingIndex],
                    message: data.message,
                    status: data.message.startsWith('\u2713') ? 'completed' : 'failed',
                    details: data.details,
                    toolCallId: data.toolCallId,
                    resultPreview: data.resultPreview,
                  };
                } else {
                  collectedActivities.push({
                    type: 'processing',
                    message: data.message,
                    status: data.message.startsWith('\u2713') ? 'completed' : 'failed',
                    details: data.details,
                    toolCallId: data.toolCallId,
                    resultPreview: data.resultPreview,
                  });
                }
                setActivityLogs([...collectedActivities]);
              } else if (data.type === 'activity' || data.type === 'thinking' || data.type === 'error') {
                collectedActivities.push({
                  type: data.type,
                  message: data.message,
                });
                setActivityLogs([...collectedActivities]);
              } else if (
                data.type === 'evidence_file' ||
                data.type === 'evidence_commit' ||
                data.type === 'evidence_resource'
              ) {
                collectedEvidence.push(data as EvidenceItem);
                setEvidenceItems([...collectedEvidence]);
              } else if (data.type === 'debug_context') {
                localDebugContext = {
                  systemPrompt: data.systemPrompt,
                  maskingStats: data.maskingStats,
                  provider: data.provider,
                  modelId: data.modelId,
                };
                setDebugContext(localDebugContext);
              } else if (data.type === 'debug_tool_call') {
                debugToolDataMapRef.current.set(data.toolCallId, {
                  toolCallId: data.toolCallId,
                  toolName: data.toolName,
                  toolArgs: data.toolArgs,
                });
              } else if (data.type === 'debug_tool_result') {
                const existing = debugToolDataMapRef.current.get(data.toolCallId);
                if (existing) {
                  existing.toolResult = data.toolResult;
                  existing.toolDurationMs = data.toolDurationMs;
                } else {
                  debugToolDataMapRef.current.set(data.toolCallId, {
                    toolCallId: data.toolCallId,
                    toolName: data.toolName,
                    toolArgs: {},
                    toolResult: data.toolResult,
                    toolDurationMs: data.toolDurationMs,
                  });
                }
              } else if (data.type === 'debug_metrics') {
                localDebugMetrics = {
                  iterations: data.iterations,
                  totalToolCalls: data.totalToolCalls,
                  totalDurationMs: data.totalDurationMs,
                  inputTokens: data.inputTokens,
                  outputTokens: data.outputTokens,
                  inputCostPerMillion: data.inputCostPerMillion,
                  outputCostPerMillion: data.outputCostPerMillion,
                };
                setDebugMetrics(localDebugMetrics);
              } else if (data.type === 'chunk') {
                accumulatedContent += data.content;
                bufferRef.current = accumulatedContent;
                if (rafIdRef.current === null) {
                  rafIdRef.current = requestAnimationFrame(flushBuffer);
                }
              } else if (data.type === 'complete_json') {
                if (rafIdRef.current !== null) {
                  cancelAnimationFrame(rafIdRef.current);
                  rafIdRef.current = null;
                }
                console.log('[ChatContainer] Received complete JSON from backend');
                receivedCompleteJson = true;
                const debugToolData =
                  debugToolDataMapRef.current.size > 0 ? Array.from(debugToolDataMapRef.current.values()) : undefined;
                const preamble =
                  typeof data.preamble === 'string' && data.preamble.trim().length > 0 ? data.preamble.trim() : null;
                const timestamp = Date.now();
                setMessages((prev) => [
                  ...prev,
                  ...(preamble
                    ? [
                        {
                          role: 'assistant' as const,
                          content: preamble,
                          timestamp,
                        },
                      ]
                    : []),
                  {
                    role: 'assistant',
                    content: data.content,
                    timestamp: timestamp + (preamble ? 1 : 0),
                    activityHistory: collectedActivities.length > 0 ? collectedActivities : undefined,
                    evidenceItems: collectedEvidence.length > 0 ? collectedEvidence : undefined,
                    totalInvestigationTimeMs: data.totalInvestigationTimeMs,
                    debugContext: localDebugContext ?? undefined,
                    debugToolData,
                    debugMetrics: localDebugMetrics ?? undefined,
                  },
                ]);
                setStreaming(false);
                setStreamingContent('');
                bufferRef.current = '';
              } else if (data.type === 'complete') {
                if (rafIdRef.current !== null) {
                  cancelAnimationFrame(rafIdRef.current);
                  rafIdRef.current = null;
                }
                if (!receivedCompleteJson && accumulatedContent.trim()) {
                  const debugToolDataComplete =
                    debugToolDataMapRef.current.size > 0 ? Array.from(debugToolDataMapRef.current.values()) : undefined;
                  setMessages((prev) => [
                    ...prev,
                    {
                      role: 'assistant',
                      content: accumulatedContent,
                      timestamp: Date.now(),
                      activityHistory: collectedActivities.length > 0 ? collectedActivities : undefined,
                      evidenceItems: collectedEvidence.length > 0 ? collectedEvidence : undefined,
                      totalInvestigationTimeMs: data.totalInvestigationTimeMs,
                      debugContext: localDebugContext ?? undefined,
                      debugToolData: debugToolDataComplete,
                      debugMetrics: localDebugMetrics ?? undefined,
                    },
                  ]);
                }
                setStreaming(false);
                setStreamingContent('');
                bufferRef.current = '';
              } else if (data.error) {
                if (rafIdRef.current !== null) {
                  cancelAnimationFrame(rafIdRef.current);
                  rafIdRef.current = null;
                }
                bufferRef.current = '';

                let chatError: ChatError;
                if (data.error === true) {
                  chatError = {
                    userMessage: data.userMessage || 'An error occurred.',
                    category: data.category || 'ambiguous',
                    suggestedAction: data.suggestedAction ?? 'retry',
                    retryAfter: data.retryAfter ?? null,
                    modelName: data.modelName || '',
                  };
                } else {
                  chatError = {
                    userMessage: data.error,
                    category: data.code === 'RATE_LIMIT_EXCEEDED' ? 'rate-limited' : 'ambiguous',
                    suggestedAction: 'retry',
                    retryAfter: data.retryAfter || null,
                    modelName: '',
                  };
                }

                setError(chatError);
                setFailedMessage(message);
                setMessages((prev) => {
                  const updated = [...prev];
                  const lastIdx = updated.length - 1;
                  if (lastIdx >= 0 && updated[lastIdx].role === 'user') {
                    updated[lastIdx] = { ...updated[lastIdx], failed: true };
                  }
                  return updated;
                });
                setStreaming(false);
                break;
              }
            } catch (error) {
              // Ignore JSON parse errors for malformed SSE chunks
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        const finalContent = bufferRef.current || accumulatedContent;
        bufferRef.current = '';
        if (finalContent.trim()) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: finalContent,
              timestamp: Date.now(),
              stopped: true,
            },
          ]);
        }
        setStreaming(false);
        setStreamingContent('');
        return;
      }
      setError({
        userMessage: 'Network error. Please try again.',
        category: 'ambiguous',
        suggestedAction: 'retry',
        retryAfter: null,
        modelName: '',
      });
      setFailedMessage(message);
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx].role === 'user') {
          updated[lastIdx] = { ...updated[lastIdx], failed: true };
        }
        return updated;
      });
      setStreaming(false);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleClearHistory = () => {
    setMessages([]);
    clearConversation();
  };

  const handleAutoFix = (service: ServiceInvestigationResult) => {
    if (!service.canAutoFix) {
      return;
    }

    let fixMessage = `User consents to fix ${service.serviceName}. `;

    if (service.suggestedFix) {
      const coreAction = service.suggestedFix
        .replace(/from '.*?' to '.*?'/, '')
        .replace(/in [\w/.+-]+\.\w+/, '')
        .replace(/at line \d+(-\d+)?/, '')
        .trim();

      if (coreAction) {
        fixMessage += `Issue: ${coreAction}`;
      }
    }

    fixMessage +=
      '\n\n[Use the get_lifecycle_config and commit_lifecycle_fix tools to apply the fix you identified earlier.]';

    sendMessage(fixMessage, { isSystemAction: true, mode: 'fix' });
  };

  const retryLastMessage = useCallback(() => {
    setFailedMessage((currentFailed) => {
      if (!currentFailed) return null;
      setError(null);
      if (autoRetryTimerRef.current !== null) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
      setMessages((prev) => prev.slice(0, -1));
      sendMessage(currentFailed);
      return null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopGeneration = () => {
    abortControllerRef.current?.abort();
  };

  const setIsAtBottom = (val: boolean) => {
    isAtBottomRef.current = val;
  };

  const scrollToBottom = () => {
    isAtBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const autoResizeTextarea = () => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && buildUuid) {
      loadConversationHistory();
    }
    return () => {
      if (mounted) {
        clearConversation();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildUuid, mounted]);

  useEffect(() => {
    if (mounted && isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent, mounted]);

  useEffect(() => {
    if (mounted) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [mounted]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (error && error.category === 'rate-limited' && error.retryAfter && error.retryAfter > 0) {
      autoRetryTimerRef.current = setTimeout(() => {
        autoRetryTimerRef.current = null;
        retryLastMessage();
      }, error.retryAfter * 1000);
    }
    return () => {
      if (autoRetryTimerRef.current !== null) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
    };
  }, [error, retryLastMessage]);

  return {
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
  };
}
