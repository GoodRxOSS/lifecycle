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

import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import { Button, Card, CardHeader, CardBody, Select, SelectItem, Spinner, Textarea, Chip, Divider, Accordion, AccordionItem } from '@heroui/react';

interface AIAgentChatProps {
  buildUuid: string;
}

interface ActivityLog {
  type: string;
  message: string;
  status?: 'pending' | 'completed' | 'failed';
  details?: {
    toolDurationMs?: number;
    totalDurationMs?: number;
  };
}

interface DebugMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  isSystemAction?: boolean;
  activityHistory?: ActivityLog[];
  totalInvestigationTimeMs?: number;
}

interface FileChange {
  path: string;
  lineNumber?: number;
  lineNumberEnd?: number;
  description?: string;
  oldContent?: string;
  newContent?: string;
}

interface ServiceInvestigationResult {
  serviceName: string;
  status: 'build_failed' | 'deploy_failed';
  issue: string;
  keyError?: string;
  errorSource?: string;
  errorSourceDetail?: string;
  suggestedFix: string;
  canAutoFix?: boolean;
  filePath?: string;
  lineNumber?: number;
  lineNumberEnd?: number;
  files?: FileChange[];
  commitUrl?: string;
}

interface StructuredDebugResponse {
  type: 'investigation_complete';
  summary: string;
  fixesApplied: boolean;
  services: ServiceInvestigationResult[];
  repository?: {
    owner: string;
    name: string;
    branch: string;
  };
}

interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
  default: boolean;
  maxTokens: number;
}

export function AIAgentChat({ buildUuid }: AIAgentChatProps) {
  const [mounted, setMounted] = useState(false);
  const [messages, setMessages] = useState<DebugMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const buildGitHubUrl = (
    repository: { owner: string; name: string; branch: string },
    filePath: string,
    lineStart?: number,
    lineEnd?: number
  ) => {
    const base = `https://github.com/${repository.owner}/${repository.name}/blob/${repository.branch}/${filePath}`;
    if (!lineStart) return base;
    const lineFragment = lineEnd && lineEnd !== lineStart ? `#L${lineStart}-L${lineEnd}` : `#L${lineStart}`;
    return base + lineFragment;
  };

  const renderFileLink = (
    filePath: string,
    repository?: { owner: string; name: string; branch: string },
    lineStart?: number,
    lineEnd?: number
  ) => {
    if (!repository) {
      return (
        <Chip variant="flat" color="default" className="font-mono text-xs">
          {filePath}
        </Chip>
      );
    }

    return (
      <Chip
        as="a"
        href={buildGitHubUrl(repository, filePath, lineStart, lineEnd)}
        target="_blank"
        rel="noopener noreferrer"
        variant="flat"
        color="primary"
        className="font-mono text-xs hover:bg-primary-100 cursor-pointer"
      >
        {filePath}
      </Chip>
    );
  };

  const renderCommitLink = (commitUrl: string) => (
    <Chip
      as="a"
      href={commitUrl}
      target="_blank"
      rel="noopener noreferrer"
      variant="flat"
      color="success"
      className="text-xs hover:bg-success-100 cursor-pointer"
    >
      View Commit
    </Chip>
  );

  const renderDiffLines = (oldContent: string, newContent: string) => (
    <div className="font-mono text-sm space-y-1">
      <div className="bg-danger-50 border-l-4 border-danger px-3 py-2 rounded">
        <span className="text-danger-900">- {oldContent}</span>
      </div>
      <div className="bg-success-50 border-l-4 border-success px-3 py-2 rounded">
        <span className="text-success-900">+ {newContent}</span>
      </div>
    </div>
  );

  const renderMultiLineDiff = (currentLines: string[], shouldBeLines: string[]) => {
    const maxLines = Math.max(currentLines.length, shouldBeLines.length);
    const diffLines: Array<{ type: 'removed' | 'added' | 'context'; content: string }> = [];

    for (let i = 0; i < maxLines; i++) {
      const currentLine = currentLines[i];
      const shouldBeLine = shouldBeLines[i];

      if (currentLine !== shouldBeLine) {
        if (currentLine !== undefined) {
          diffLines.push({ type: 'removed', content: currentLine });
        }
        if (shouldBeLine !== undefined) {
          diffLines.push({ type: 'added', content: shouldBeLine });
        }
      } else if (currentLine !== undefined) {
        diffLines.push({ type: 'context', content: currentLine });
      }
    }

    return (
      <div className="font-mono text-sm space-y-1 max-h-96 overflow-y-auto">
        {diffLines.map((line, idx) => (
          <div
            key={idx}
            className={`px-3 py-1.5 rounded ${line.type === 'removed'
              ? 'bg-danger-50 border-l-4 border-danger'
              : line.type === 'added'
                ? 'bg-success-50 border-l-4 border-success'
                : 'bg-gray-50 border-l-4 border-transparent'
              }`}
          >
            <span
              className={
                line.type === 'removed'
                  ? 'text-danger-900'
                  : line.type === 'added'
                    ? 'text-success-900'
                    : 'text-gray-700'
              }
            >
              {line.type === 'removed' ? '- ' : line.type === 'added' ? '+ ' : '  '}
              {line.content}
            </span>
          </div>
        ))}
      </div>
    );
  };

  const renderSimpleFallbackService = (service: any) => (
    <Card className="border border-gray-200">
      <CardHeader className="pb-2">
        <h4 className="text-base font-semibold text-gray-800">{service.serviceName}</h4>
      </CardHeader>
      <CardBody className="pt-2">
        {service.issue && (
          <p className="text-sm text-gray-700 mb-2">{service.issue}</p>
        )}
        {service.suggestedFix && (
          <Card className="bg-success-50 border border-success-200 mt-2">
            <CardBody className="py-2">
              <p className="text-sm text-success-700">{service.suggestedFix}</p>
            </CardBody>
          </Card>
        )}
      </CardBody>
    </Card>
  );

  const renderFixesAppliedBanner = () => (
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

  const formatDuration = (durationMs?: number): string => {
    if (durationMs === undefined || durationMs === null) return '';

    if (durationMs < 1000) {
      return `${durationMs}ms`;
    }

    const seconds = (durationMs / 1000).toFixed(1);
    return `${seconds}s`;
  };

  const renderActivityHistory = (activities: ActivityLog[], totalInvestigationTimeMs?: number) => {
    if (!activities || activities.length === 0) return null;

    return (
      <div className="mb-3">
        <Accordion
          variant="light"
          className="px-0"
          itemClasses={{
            base: "bg-gray-50/50 rounded",
            title: "text-xs font-medium text-gray-500",
            trigger: "px-2 py-1.5 hover:bg-gray-100/50 min-h-0 h-auto",
            content: "px-0 pt-0 pb-0",
            indicator: "text-gray-400",
          }}
        >
          <AccordionItem
            key="1"
            aria-label="Thinking process"
            title={
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-gray-500">Thinking process</span>
                <Chip color="default" variant="flat" size="sm" className="bg-gray-200/70 text-gray-600 h-4 text-[10px] px-1.5">
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
            <div className="bg-gray-50/30 border-t border-gray-200 px-2 py-2 space-y-1.5">
              {activities.map((activity, idx) => {
                const toolDuration = activity.details?.toolDurationMs;
                const totalDuration = activity.details?.totalDurationMs;

                let durationDisplay = '';
                if (totalDuration !== undefined) {
                  const totalText = formatDuration(totalDuration);
                  if (toolDuration !== undefined && toolDuration > 0) {
                    const llmDuration = totalDuration - toolDuration;
                    const toolText = formatDuration(toolDuration);
                    const llmText = formatDuration(llmDuration);
                    durationDisplay = `${totalText} (tool/${toolText} LLM/${llmText})`;
                  } else {
                    durationDisplay = totalText;
                  }
                }

                return (
                  <div key={idx} className="text-[11px]">
                    <div className="text-[11px] text-gray-600 leading-tight">
                      {activity.message}
                    </div>
                    {durationDisplay && (
                      <div className="pl-5 leading-tight">
                        <span className="text-[10px] text-gray-400 font-mono">
                          {durationDisplay}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </AccordionItem>
        </Accordion>
      </div>
    );
  };

  const autoResizeTextarea = () => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
    }
  };

  const parseStructuredResponse = (content: string): StructuredDebugResponse | null => {
    try {
      let cleaned = content.trim();

      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
        cleaned = cleaned.trim();
      }

      if (!cleaned.startsWith('{')) {
        return null;
      }

      const parsed = JSON.parse(cleaned);

      if (parsed.type === 'investigation_complete' && Array.isArray(parsed.services)) {
        return {
          ...parsed,
          fixesApplied: parsed.fixesApplied ?? false,
        } as StructuredDebugResponse;
      }

      return null;
    } catch (error) {
      return null;
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
    if (mounted) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent, mounted]);

  useEffect(() => {
    if (mounted) {
      loadAvailableModels();
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [mounted]);

  const loadAvailableModels = async () => {
    try {
      const response = await fetch('/api/v1/ai/models');
      if (response.ok) {
        const data = await response.json();
        setAvailableModels(data.models || []);

        const storedModelKey = localStorage.getItem('aiAgentSelectedModel');
        if (storedModelKey && data.models?.length > 0) {
          const storedModel = data.models.find(
            (m: ModelOption) => `${m.provider}:${m.modelId}` === storedModelKey
          );
          if (storedModel) {
            setSelectedModel(storedModel);
            return;
          }
        }

        const defaultModel = data.models?.find((m: ModelOption) => m.default);
        if (defaultModel) {
          setSelectedModel(defaultModel);
        } else if (data.models?.length > 0) {
          setSelectedModel(data.models[0]);
        }
      }
    } catch (error) {
      console.error('Failed to load available models:', error);
    }
  };

  const handleModelChange = (modelKey: string) => {
    const model = availableModels.find((m) => `${m.provider}:${m.modelId}` === modelKey);
    if (model) {
      setSelectedModel(model);
      localStorage.setItem('aiAgentSelectedModel', modelKey);
    }
  };

  const loadConversationHistory = async () => {
    try {
      const response = await fetch(`/api/v1/ai/messages/${buildUuid}`);
      if (response.ok) {
        const data = await response.json();
        setMessages(data.messages || []);
      }
    } catch (error) {
      console.log('No previous conversation found');
    }
  };

  const clearConversation = async () => {
    try {
      await fetch(`/api/v1/ai/session/${buildUuid}`, { method: 'DELETE' });
    } catch (error) {
      console.error('Failed to clear conversation:', error);
    }
  };

  const sendMessage = async (message: string, isSystemAction: boolean = false) => {
    if (!message.trim()) return;

    setInput('');
    setLoading(true);
    setStreaming(true);
    setStreamingContent('');
    setActivityLogs([]);
    setError(null);

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: message, timestamp: Date.now(), isSystemAction },
    ]);

    try {
      const requestBody: any = { buildUuid, message, isSystemAction };
      if (selectedModel) {
        requestBody.provider = selectedModel.provider;
        requestBody.modelId = selectedModel.modelId;
      }

      const response = await fetch('/api/v1/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedContent = '';
      let receivedCompleteJson = false;
      const collectedActivities: ActivityLog[] = [];

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
                });
                setActivityLogs([...collectedActivities]);
              } else if (data.type === 'processing') {
                const resultMessage = data.message.replace(/^[✓]\s*/, '').replace(/^Failed to\s*/i, '');

                const matchingIndex = collectedActivities.findIndex(
                  a => a.status === 'pending' &&
                    (a.message === resultMessage ||
                      a.message.toLowerCase() === resultMessage.toLowerCase() ||
                      resultMessage.toLowerCase().includes(a.message.toLowerCase()))
                );

                if (matchingIndex !== -1) {
                  collectedActivities[matchingIndex] = {
                    ...collectedActivities[matchingIndex],
                    message: data.message,
                    status: data.message.startsWith('✓') ? 'completed' : 'failed',
                    details: data.details,
                  };
                } else {
                  collectedActivities.push({
                    type: 'processing',
                    message: data.message,
                    status: data.message.startsWith('✓') ? 'completed' : 'failed',
                    details: data.details,
                  });
                }
                setActivityLogs([...collectedActivities]);
              } else if (data.type === 'activity' || data.type === 'thinking' || data.type === 'error') {
                collectedActivities.push({
                  type: data.type,
                  message: data.message,
                });
                setActivityLogs([...collectedActivities]);
              } else if (data.type === 'chunk') {
                accumulatedContent += data.content;
                setStreamingContent(accumulatedContent);
              } else if (data.type === 'complete_json') {
                console.log('[AIAgentChat] Received complete JSON from backend');
                receivedCompleteJson = true;
                setMessages((prev) => [...prev, {
                  role: 'assistant',
                  content: data.content,
                  timestamp: Date.now(),
                  activityHistory: collectedActivities.length > 0 ? collectedActivities : undefined,
                  totalInvestigationTimeMs: data.totalInvestigationTimeMs,
                }]);
                setStreaming(false);
                setStreamingContent('');
              } else if (data.type === 'complete') {
                if (!receivedCompleteJson && accumulatedContent.trim()) {
                  setMessages((prev) => [...prev, {
                    role: 'assistant',
                    content: accumulatedContent,
                    timestamp: Date.now(),
                    activityHistory: collectedActivities.length > 0 ? collectedActivities : undefined,
                    totalInvestigationTimeMs: data.totalInvestigationTimeMs,
                  }]);
                }
                setStreaming(false);
                setStreamingContent('');
              } else if (data.error) {
                const errorMsg = data.code === 'RATE_LIMIT_EXCEEDED'
                  ? `${data.error} (Please wait ${data.retryAfter || 60} seconds)`
                  : data.error;
                setError(errorMsg);
                setMessages((prev) => prev.slice(0, -1));
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
      setError('Network error. Please try again.');
      setMessages((prev) => prev.slice(0, -1));
      setStreaming(false);
    } finally {
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

  const suggestedQuestions = [
    "Why is my build failing?",
    "What's wrong with deployments?",
    "Why are my pods not starting?",
  ];

  const handleClearHistory = async () => {
    await clearConversation();
    setMessages([]);
  };

  const handleAutoFix = (service: ServiceInvestigationResult) => {
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

    fixMessage += '\n\n[Use the get_lifecycle_config and commit_lifecycle_fix tools to apply the fix you identified earlier.]';

    sendMessage(fixMessage, true);
  };

  const parseSuggestedFix = (suggestedFix: string) => {
    const match = suggestedFix.match(/from '([^']+)' to '([^']+)' in ([\w/.+-]+\.\w+)/);
    if (match) {
      return {
        type: 'single-line' as const,
        oldValue: match[1],
        newValue: match[2],
        file: match[3].trim().replace(/[.,;:!]+$/, ''),
      };
    }

    const currentMatch = suggestedFix.match(/Current \(incorrect\):\s*([\s\S]*?)Should be:\s*([\s\S]*?)$/);
    if (currentMatch) {
      const headerMatch = suggestedFix.match(/^(.*?)(?:at lines? (\d+)(?:-(\d+))?)? in ([\w/.+-]+\.\w+)/);

      return {
        type: 'multi-line' as const,
        description: headerMatch ? headerMatch[1].trim() : '',
        startLine: headerMatch && headerMatch[2] ? parseInt(headerMatch[2]) : undefined,
        endLine: headerMatch && headerMatch[3] ? parseInt(headerMatch[3]) : (headerMatch && headerMatch[2] ? parseInt(headerMatch[2]) : undefined),
        file: headerMatch ? headerMatch[4].trim().replace(/[.,;:!]+$/, '') : null,
        currentLines: currentMatch[1].trim().split('\n'),
        shouldBeLines: currentMatch[2].trim().split('\n'),
      };
    }

    return null;
  };

  // eslint-disable-next-line react/prop-types
  const ServiceCard = ({ service, fixesApplied, repository }: { service: ServiceInvestigationResult, fixesApplied: boolean, repository?: { owner: string; name: string; branch: string } }) => {
    const parsedFix = parseSuggestedFix(service.suggestedFix);
    const hasMultipleFiles = service.files && service.files.length > 0;
    const [showDetails, setShowDetails] = useState(false);

    const getFilePath = () => {
      if (service.filePath) return service.filePath;
      if (parsedFix) return parsedFix.file;
      const inMatch = service.suggestedFix.match(/in ([\w/.+-]+\.\w+)/);
      return inMatch ? inMatch[1].replace(/[.,;:!]+$/, '') : null;
    };

    const getLineNumbers = () => {
      if (service.lineNumber && service.lineNumberEnd) {
        return { start: service.lineNumber, end: service.lineNumberEnd };
      }
      if (parsedFix && parsedFix.type === 'multi-line' && parsedFix.startLine) {
        return { start: parsedFix.startLine, end: parsedFix.endLine || parsedFix.startLine };
      }
      return null;
    };

    return (
      <Card className="mb-6 border-2 border-gray-200 shadow-sm">
        <CardHeader className="bg-gradient-to-r from-gray-50 to-gray-100 border-b-2 border-gray-200 py-4 px-5">
          <div className="w-full flex items-center justify-between">
            <div>
              <h4 className="text-lg font-bold text-gray-900 mb-2">{service.serviceName}</h4>
              <Chip size="sm" variant="flat" color="warning">
                {service.status.replace('_', ' ')}
              </Chip>
            </div>
            {!fixesApplied && service.canAutoFix && (
              <Button
                onClick={() => handleAutoFix(service)}
                isDisabled={loading}
                size="md"
                color="success"
                variant="shadow"
                className="font-bold"
              >
                Fix it for me
              </Button>
            )}
          </div>
        </CardHeader>
        <CardBody className="p-6 space-y-6">
          <div>
            <p className="text-base text-gray-800 leading-relaxed font-medium">{service.issue}</p>
          </div>

          {service.keyError && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h5 className="text-base font-bold text-danger">Error Details</h5>
                <Button
                  size="sm"
                  variant="light"
                  onClick={() => setShowDetails(!showDetails)}
                  className="text-xs"
                >
                  {showDetails ? 'Hide' : 'Show'} details
                </Button>
              </div>
              {showDetails && (
                <>
                  {service.errorSource && (
                    <div className="text-sm text-gray-700">
                      <span className="font-semibold">Source:</span> {service.errorSource}
                    </div>
                  )}
                  <Card className="bg-danger-50 border-l-4 border-danger">
                    <CardBody className="p-4">
                      <pre className="text-sm text-danger-900 overflow-x-auto m-0 leading-relaxed font-mono whitespace-pre-wrap">
                        {service.keyError}
                      </pre>
                    </CardBody>
                  </Card>
                </>
              )}
            </div>
          )}

          <Divider className="my-4" />

          <div className={fixesApplied ? 'bg-success-50 border-l-4 border-success p-4 rounded' : ''}>
            <div className="mb-4">
              <h5 className={`text-base font-bold ${fixesApplied ? 'text-success-800' : 'text-gray-900'}`}>
                {fixesApplied ? '✓ Fix Applied' : 'Suggested Fix'}
              </h5>
            </div>
            {hasMultipleFiles ? (
              <div className="space-y-4">
                <div className="flex gap-2 items-center">
                  <Chip size="sm" variant="flat" color="primary">
                    {service.files.length} file{service.files.length > 1 ? 's' : ''}
                  </Chip>
                  <span className="text-sm text-gray-600">to update</span>
                </div>
                {service.files.map((file, idx) => (
                  <div key={idx} className="p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-3">
                    <div className="flex gap-2 items-center">
                      {renderFileLink(file.path, repository, file.lineNumber, file.lineNumberEnd)}
                    </div>
                    {file.description && (
                      <p className="text-sm text-gray-700">{file.description}</p>
                    )}
                    {file.oldContent && file.newContent && (
                      <div className="mt-2">
                        {renderDiffLines(file.oldContent, file.newContent)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : parsedFix && parsedFix.type === 'single-line' ? (
              <div className="space-y-4">
                <div className="flex gap-2 items-center flex-wrap">
                  {renderFileLink(parsedFix.file, repository, service.lineNumber, service.lineNumberEnd)}
                  {fixesApplied && service.commitUrl && renderCommitLink(service.commitUrl)}
                </div>
                <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                  <p className="text-sm text-gray-700 mb-3">{service.suggestedFix.split(' in ')[0]}</p>
                  <div className="font-mono text-sm space-y-1">
                    <div className="bg-danger-50 border-l-4 border-danger px-3 py-2 rounded">
                      <span className="text-danger-900">- {parsedFix.oldValue}</span>
                    </div>
                    <div className="bg-success-50 border-l-4 border-success px-3 py-2 rounded">
                      <span className="text-success-900">+ {parsedFix.newValue}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : parsedFix && parsedFix.type === 'multi-line' ? (
              <div className="space-y-4">
                {getFilePath() && (
                  <div className="flex gap-2 items-center flex-wrap">
                    {renderFileLink(getFilePath()!, repository, getLineNumbers()?.start, getLineNumbers()?.end)}
                    {fixesApplied && service.commitUrl && renderCommitLink(service.commitUrl)}
                  </div>
                )}
                {parsedFix.description && (
                  <p className="text-sm text-gray-700">{parsedFix.description}</p>
                )}
                <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                  {renderMultiLineDiff(parsedFix.currentLines, parsedFix.shouldBeLines)}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                  <pre className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap font-mono m-0">
                    {service.suggestedFix}
                  </pre>
                </div>
                {fixesApplied && service.commitUrl && renderCommitLink(service.commitUrl)}
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    );
  };

  const renderStructuredResponse = (structured: StructuredDebugResponse) => (
    <div className="space-y-4">
      {structured.fixesApplied && renderFixesAppliedBanner()}
      <p className="text-sm text-gray-700 leading-relaxed mb-6">{structured.summary}</p>
      <div className="space-y-4">
        {/* eslint-disable react/prop-types */}
        {structured.services.map((service) => (
          <ServiceCard
            key={service.serviceName}
            service={service}
            fixesApplied={structured.fixesApplied}
            repository={structured.repository}
          />
        ))}
        {/* eslint-enable react/prop-types */}
      </div>
    </div>
  );

  const renderMessage = (content: string, isStreaming: boolean = false) => {
    if (!isStreaming) {
      const structured = parseStructuredResponse(content);
      if (structured) {
        return renderStructuredResponse(structured);
      }
    }

    if (isStreaming && content.trim().startsWith('{') && content.includes('"type"') && content.includes('"investigation_complete"')) {
      return (
        <Card className="bg-gray-50 border border-gray-200">
          <CardBody className="p-3">
            <p className="text-sm text-gray-600 italic mb-1">Generating investigation report...</p>
            <p className="text-xs text-gray-500 opacity-70">Collecting data from {content.match(/"serviceName"/g)?.length || 0} service(s)</p>
          </CardBody>
        </Card>
      );
    }

    if (!isStreaming && content.trim().startsWith('{')) {
      try {
        const json = JSON.parse(content.trim());
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
        if (e instanceof SyntaxError && e.message.includes('position')) {
          let recovered = content.trim();
          const lastCompleteService = recovered.lastIndexOf('}');

          if (lastCompleteService > 0) {
            recovered = recovered.substring(0, lastCompleteService + 1);
            if (!recovered.includes(']')) {
              recovered += '\n  ]\n}';
            } else if (!recovered.endsWith('}')) {
              recovered += '\n}';
            }

            try {
              const json = JSON.parse(recovered);
              if (json.type === 'investigation_complete' && json.services) {
                return (
                  <div className="space-y-4">
                    <Card className="bg-warning-50 border border-warning">
                      <CardBody className="py-2 px-3">
                        <p className="text-xs text-warning-800">Response was truncated - showing partial results</p>
                      </CardBody>
                    </Card>
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
            } catch (recoveryError) {
              // Ignore recovery parse errors
            }
          }
        }

        if (content.trim().startsWith('{')) {
          return (
            <Card className="bg-danger-50 border border-danger">
              <CardHeader className="pb-2">
                <h5 className="text-sm font-semibold text-danger">Malformed Response</h5>
              </CardHeader>
              <CardBody className="pt-2">
                <p className="text-xs text-gray-600 mb-2">
                  The response appears to be truncated or malformed. Showing raw content:
                </p>
                <Card className="bg-white border border-gray-200">
                  <CardBody className="p-3">
                    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs text-gray-700 max-h-96 overflow-y-auto">
                      {content.trim()}
                    </pre>
                  </CardBody>
                </Card>
              </CardBody>
            </Card>
          );
        }
      }
    }

    return (
      <ReactMarkdown
        components={{
          a({ children, href, ...props }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
          code({ inline, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';

            const fullMatch = /language-(\w+):(\d+)\{([\d,\s]+)\}/.exec(className || '');
            const simpleMatch = /language-(\w+)\{([\d,\s]+)\}/.exec(className || '');

            let startingLineNumber = 1;
            let highlightLines: number[] = [];

            if (fullMatch) {
              startingLineNumber = parseInt(fullMatch[2]);
              highlightLines = fullMatch[3].split(',').map(n => parseInt(n.trim()));
            } else if (simpleMatch) {
              highlightLines = simpleMatch[2].split(',').map(n => parseInt(n.trim()));
            }

            return !inline && language ? (
              <div style={{ position: 'relative' }}>
                <style>{`
                  .syntax-no-underline * {
                    border: none !important;
                  }
                `}</style>
                <SyntaxHighlighter
                  language={language}
                  style={oneDark}
                  customStyle={{ borderRadius: '6px', fontSize: '0.875rem' }}
                  className="syntax-no-underline"
                  wrapLines={highlightLines.length > 0}
                  showLineNumbers={highlightLines.length > 0}
                  startingLineNumber={startingLineNumber}
                  lineProps={(lineNumber) => {
                    if (highlightLines.includes(lineNumber)) {
                      return {
                        style: {
                          backgroundColor: 'rgba(239, 68, 68, 0.2)',
                          display: 'block',
                          borderLeft: '3px solid #ef4444',
                          paddingLeft: '8px',
                        }
                      };
                    }
                    return {};
                  }}
                  {...props}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    );
  };

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
        <div className="flex items-center gap-2">
          {availableModels.length > 0 && (
            <Select
              label="Model"
              labelPlacement="outside-left"
              size="sm"
              className="w-60"
              variant="bordered"
              selectedKeys={selectedModel ? [`${selectedModel.provider}:${selectedModel.modelId}`] : []}
              onSelectionChange={(keys) => {
                const key = Array.from(keys)[0] as string;
                if (key) handleModelChange(key);
              }}
              isDisabled={loading}
              classNames={{
                label: "text-xs text-gray-600 font-semibold",
                trigger: "border-gray-200 hover:border-gray-300",
              }}
            >
              {availableModels.map((model) => (
                <SelectItem key={`${model.provider}:${model.modelId}`}>
                  {model.displayName}
                </SelectItem>
              ))}
            </Select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <Button
              onClick={handleClearHistory}
              isDisabled={loading}
              size="sm"
              variant="flat"
              color="danger"
              className="font-semibold"
            >
              Clear
            </Button>
          )}
        </div>
      </CardHeader>

      {error && (
        <Card className="mx-6 my-3 border-2 border-danger">
          <CardBody className="py-3">
            <p className="text-sm text-danger font-medium">{error}</p>
          </CardBody>
        </Card>
      )}

      <CardBody className="flex-1 overflow-y-auto p-8 bg-white shadow-none border-0">
        {messages.length === 0 && !streaming ? (
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
              <form onSubmit={handleSubmit} className="w-full">
                <div className="relative">
                  <Textarea
                    ref={inputRef}
                    value={input}
                    onValueChange={(value) => {
                      setInput(value);
                      autoResizeTextarea();
                    }}
                    placeholder={`Ask anything about ${buildUuid}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmit(e);
                      }
                    }}
                    minRows={2}
                    maxRows={8}
                    variant="bordered"
                    size="lg"
                    classNames={{
                      inputWrapper: "bg-gray-50 border border-gray-200 hover:border-gray-300 focus-within:border-gray-300 data-[hover=true]:bg-gray-50 pr-16 rounded-3xl shadow-none outline-none min-h-[72px]",
                      input: "text-lg pr-2 placeholder:text-gray-400 outline-none focus:outline-none py-4",
                    }}
                  />
                  <Button
                    type="submit"
                    isDisabled={!input.trim() || loading}
                    isIconOnly
                    className={`absolute right-3 bottom-3 transition-all ${!input.trim() || loading
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-gray-800 text-white hover:bg-gray-700'
                      }`}
                    size="lg"
                    radius="full"
                  >
                    {loading ? (
                      <Spinner size="sm" color="current" />
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                        <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                      </svg>
                    )}
                  </Button>
                </div>
              </form>
            </div>

            <div className="flex flex-col gap-2 w-full max-w-2xl">
              <p className="text-xs text-gray-400 mb-1">Others are asking:</p>
              {suggestedQuestions.map((q, idx) => (
                <Button
                  key={idx}
                  onClick={() => sendMessage(q)}
                  isDisabled={loading}
                  size="sm"
                  variant="light"
                  color="default"
                  className="justify-center text-center h-auto py-2 px-3 text-gray-500"
                  style={{
                    backgroundColor: 'transparent',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgb(243 244 246)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <span className="text-sm">{q}</span>
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="max-w-5xl mx-auto w-full px-8 pb-32">
          {messages.map((msg, idx) => (
            msg.role === 'user' && msg.isSystemAction ? (
              <div key={idx} className="message-fade-in flex items-center gap-4 mb-8">
                <Divider className="flex-1" />
                <Chip size="sm" variant="flat" color="success" className="font-semibold">
                  Aplying suggested fix
                </Chip>
                <Divider className="flex-1" />
              </div>
            ) : msg.role === 'user' ? (
              <div key={idx} className="message-fade-in mb-6 flex justify-end">
                <Card
                  className="max-w-[70%] shadow-md hover:shadow-lg transition-shadow duration-200"
                  style={{
                    background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                  }}
                >
                  <CardBody className="px-5 py-3">
                    <div className="user-message-content">
                      <div className="text-white font-medium">{msg.content}</div>
                    </div>
                  </CardBody>
                </Card>
              </div>
            ) : (
              <div key={idx} className="message-fade-in mb-6 w-[80%]">
                <div className="ai-message-content">
                  {msg.activityHistory && renderActivityHistory(msg.activityHistory, msg.totalInvestigationTimeMs)}
                  {renderMessage(msg.content, false)}
                </div>
              </div>
            )
          ))}

          {streaming && streamingContent && (
            <div className="message-fade-in mb-6 w-[80%]">
              <div className="ai-message-content">
                {activityLogs.length > 0 && renderActivityHistory(activityLogs)}
                {renderMessage(streamingContent, true)}
                <span className="typing-cursor">▊</span>
              </div>
            </div>
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
                  {renderActivityHistory(activityLogs)}
                </div>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </CardBody>

      {(messages.length > 0 || streaming) && (
        <div className="fixed bottom-0 left-0 right-0 px-8 pb-8 pt-8 z-10 bg-transparent">
          <div className="max-w-5xl mx-auto w-full">
            <form onSubmit={handleSubmit} className="w-full">
              <div className="relative">
                <Textarea
                  ref={inputRef}
                  value={input}
                  onValueChange={(value) => {
                    setInput(value);
                    autoResizeTextarea();
                  }}
                  placeholder={`Ask anything about ${buildUuid}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  minRows={2}
                  maxRows={8}
                  variant="bordered"
                  size="lg"
                  classNames={{
                    inputWrapper: "bg-gray-50 border border-gray-200 hover:border-gray-300 focus-within:border-gray-300 data-[hover=true]:bg-gray-50 pr-16 rounded-3xl shadow-none outline-none min-h-[72px]",
                    input: "text-lg pr-2 placeholder:text-gray-400 outline-none focus:outline-none py-4",
                  }}
                />
                <Button
                  type="submit"
                  isDisabled={!input.trim() || loading}
                  isIconOnly
                  className={`absolute right-3 bottom-3 transition-all ${!input.trim() || loading
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-gray-800 text-white hover:bg-gray-700'
                    }`}
                  size="lg"
                  radius="full"
                >
                  {loading ? (
                    <Spinner size="sm" color="current" />
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                      <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                    </svg>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* eslint-disable-next-line react/no-unknown-property */}
      <style jsx global>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }

        @keyframes thinking {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .message-fade-in {
          animation: fadeInUp 0.3s ease-out;
        }

        .typing-cursor {
          animation: blink 1s infinite;
          margin-left: 2px;
          color: #667eea;
          font-weight: bold;
        }

        .thinking-dots {
          display: flex;
          gap: 4px;
        }

        .thinking-dots span {
          animation: thinking 1.4s infinite;
          font-size: 8px;
        }

        .thinking-dots span:nth-child(2) {
          animation-delay: 0.2s;
        }

        .thinking-dots span:nth-child(3) {
          animation-delay: 0.4s;
        }

        .ai-message-content {
          line-height: 1.7;
          font-size: 14px;
          color: #1f2937;
        }

        .user-message-content {
          line-height: 1.7;
          font-size: 14px;
        }

        .ai-message-content p,
        .user-message-content p {
          margin: 0 0 0.75rem 0;
        }

        .ai-message-content p:last-child,
        .user-message-content p:last-child {
          margin-bottom: 0;
        }

        .ai-message-content ul, .ai-message-content ol {
          margin: 0.75rem 0;
          padding-left: 1.5rem;
        }

        .ai-message-content li {
          margin: 0.375rem 0;
        }

        .ai-message-content code {
          background: #f3f4f6;
          padding: 3px 8px;
          border-radius: 4px;
          font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
          font-size: 13px;
          color: #be185d;
          border: 1px solid #e5e7eb;
        }

        .user-message-content code {
          background: rgba(255, 255, 255, 0.2);
          padding: 3px 8px;
          border-radius: 4px;
          font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
          font-size: 13px;
          color: white;
          border: 1px solid rgba(255, 255, 255, 0.3);
        }

        .ai-message-content pre {
          margin: 1rem 0;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        .ai-message-content pre > div {
          margin: 0 !important;
          border-radius: 8px !important;
          font-size: 13px !important;
        }

        .ai-message-content strong {
          font-weight: 600;
          color: #111827;
        }

        .user-message-content strong {
          font-weight: 600;
          color: white;
        }

        .ai-message-content a {
          color: #667eea;
          text-decoration: none;
          font-weight: 500;
        }

        .ai-message-content a:hover {
          text-decoration: underline;
        }

        .user-message-content a {
          color: rgba(255, 255, 255, 0.9);
          text-decoration: underline;
          font-weight: 500;
        }

        .user-message-content a:hover {
          color: white;
        }

        .ai-message-content h1,
        .ai-message-content h2,
        .ai-message-content h3 {
          margin: 1rem 0 0.5rem 0;
          font-weight: 600;
          color: #111827;
        }

        .ai-message-content h1 { font-size: 1.25rem; }
        .ai-message-content h2 { font-size: 1.125rem; }
        .ai-message-content h3 { font-size: 1rem; }

        .ai-message-content blockquote {
          margin: 1rem 0;
          padding: 0.75rem 1rem;
          border-left: 3px solid #667eea;
          background: #f9fafb;
          border-radius: 4px;
          color: #4b5563;
        }
      `}</style>
    </Card>
  );
}
