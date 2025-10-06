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

interface AIDebugChatProps {
  buildUuid: string;
}

interface DebugMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export function AIDebugChat({ buildUuid }: AIDebugChatProps) {
  const [messages, setMessages] = useState<DebugMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [currentActivity, setCurrentActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const autoResizeTextarea = () => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
    }
  };

  useEffect(() => {
    loadConversationHistory();
    return () => {
      clearConversation();
    };
  }, [buildUuid]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const loadConversationHistory = async () => {
    try {
      const response = await fetch(`/api/v2/debug/messages/${buildUuid}`);
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
      await fetch(`/api/v2/debug/session/${buildUuid}`, { method: 'DELETE' });
    } catch (error) {
      console.error('Failed to clear conversation:', error);
    }
  };

  const sendMessage = async (message: string) => {
    if (!message.trim()) return;

    setInput('');
    if (inputRef.current) {
      inputRef.current.style.height = '44px';
    }
    setLoading(true);
    setStreaming(true);
    setStreamingContent('');
    setCurrentActivity(null);
    setError(null);

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: message, timestamp: Date.now() },
    ]);

    try {
      const response = await fetch('/api/v2/debug/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildUuid, message }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'activity' || data.type === 'tool_call') {
                setCurrentActivity(data.message);
              } else if (data.type === 'chunk') {
              accumulatedContent += data.content;
              setStreamingContent(accumulatedContent);
            } else if (data.type === 'complete') {
              setCurrentActivity(null);
              setMessages((prev) => [...prev, {
                role: 'assistant',
                content: accumulatedContent,
                timestamp: Date.now(),
              }]);
              setStreaming(false);
              setStreamingContent('');
            } else if (data.error) {
              const errorMsg = data.code === 'RATE_LIMIT_EXCEEDED'
                ? `⏱️ ${data.error} (Please wait ${data.retryAfter || 60} seconds)`
                : data.error;
              setError(errorMsg);
              setMessages((prev) => prev.slice(0, -1));
              setStreaming(false);
              break;
            }
            } catch (error) {
              // Ignore parse errors for incomplete SSE messages
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
    if (confirm('Are you sure you want to clear the conversation history?')) {
      await clearConversation();
      setMessages([]);
    }
  };

  return (
    <div style={{ 
      height: 'calc(100vh - 200px)', 
      display: 'flex', 
      flexDirection: 'column', 
      background: 'white',
      borderRadius: '12px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ 
        padding: '1.25rem 1.5rem', 
        borderBottom: '1px solid #e5e7eb', 
        background: 'linear-gradient(to bottom, #ffffff, #fafafa)',
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center' 
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div>
            <div style={{ fontSize: '1.125rem', color: '#374151', fontWeight: 600 }}>
              AI Debug Assistant
            </div>
            <div style={{ fontSize: '0.875rem', color: '#6b7280', fontWeight: 400 }}>
              Ask me about deployments, pods, logs, or configuration
            </div>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClearHistory}
            disabled={loading}
            style={{
              padding: '0.5rem 1rem',
              background: 'transparent',
              color: '#6b7280',
              border: '1px solid #e5e7eb',
              borderRadius: '6px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500,
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                e.currentTarget.style.background = '#fee';
                e.currentTarget.style.borderColor = '#fca5a5';
                e.currentTarget.style.color = '#dc2626';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderColor = '#e5e7eb';
              e.currentTarget.style.color = '#6b7280';
            }}
          >
            Clear History
          </button>
        )}
      </div>
      
      {/* Error Banner */}
      {error && (
        <div style={{ 
          padding: '1rem 1.5rem', 
          background: '#fef2f2', 
          color: '#991b1b', 
          borderBottom: '1px solid #fecaca',
          fontSize: '0.875rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}>
          <span style={{ fontSize: '1.125rem' }}>⚠️</span>
          <span>{error}</span>
        </div>
      )}
      
      {/* Messages Area */}
      <div style={{ 
        flex: 1, 
        overflowY: 'auto', 
        padding: '1.5rem',
        background: '#fafafa',
      }}>
        {messages.length === 0 && !streaming && (
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            textAlign: 'center',
          }}>
            <div style={{ 
              fontSize: '3rem', 
              marginBottom: '1rem',
              opacity: 0.3,
            }}>
              💬
            </div>
            <h3 style={{ 
              margin: '0 0 0.5rem 0', 
              color: '#374151',
              fontWeight: 600,
              fontSize: '1.125rem',
            }}>
              Start a Conversation
            </h3>
            <p style={{ 
              margin: '0 0 2rem 0', 
              color: '#6b7280',
              fontSize: '0.875rem',
              maxWidth: '400px',
            }}>
              Ask me anything about your Kubernetes environment, deployments, or configuration issues
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', maxWidth: '500px' }}>
              {suggestedQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => sendMessage(q)}
                  disabled={loading}
                  style={{
                    padding: '1rem 1.5rem',
                    border: '1px solid #e5e7eb',
                    background: 'white',
                    color: '#374151',
                    borderRadius: '8px',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    fontSize: '0.875rem',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  }}
                  onMouseEnter={(e) => {
                    if (!loading) {
                      e.currentTarget.style.borderColor = '#667eea';
                      e.currentTarget.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.15)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = '#e5e7eb';
                    e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
                  }}
                >
                  <span style={{ marginRight: '0.5rem', opacity: 0.6 }}>💬</span>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className="message-fade-in"
            style={{
              marginBottom: '1.5rem',
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div style={{
              width: msg.role === 'user' ? 'auto' : '65%',
              maxWidth: msg.role === 'user' ? '60%' : '65%',
              background: msg.role === 'user'
                ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'
                : 'white',
              color: msg.role === 'user' ? 'white' : 'inherit',
              padding: '1rem 1.25rem',
              borderRadius: '12px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            }}>
              <div className={msg.role === 'user' ? 'user-message-content' : 'ai-message-content'}>
                <ReactMarkdown
                  components={{
                    a({ node, children, href, ...props }) {
                      return (
                        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                          {children}
                        </a>
                      );
                    },
                    code({ node, inline, className, children, ...props }) {
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
                              border-bottom: none !important;
                            }
                          `}</style>
                          <SyntaxHighlighter
                            className="syntax-no-underline"
                            style={oneDark}
                            language={language}
                            PreTag="div"
                            customStyle={{
                              background: '#282c34',
                            }}
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
                  {msg.content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ))}

        {streaming && streamingContent && (
          <div
            className="message-fade-in"
            style={{
              marginBottom: '1.5rem',
              display: 'flex',
              justifyContent: 'flex-start',
            }}>
            <div style={{
              width: '65%',
              maxWidth: '65%',
              background: 'white',
              padding: '1rem 1.25rem',
              borderRadius: '12px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            }}>
              <div className="ai-message-content">
                <ReactMarkdown
                  components={{
                    a({ node, children, href, ...props }) {
                      return (
                        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                          {children}
                        </a>
                      );
                    },
                    code({ node, inline, className, children, ...props }) {
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
                              border-bottom: none !important;
                            }
                          `}</style>
                          <SyntaxHighlighter
                            className="syntax-no-underline"
                            style={oneDark}
                            language={language}
                            PreTag="div"
                            customStyle={{
                              background: '#282c34',
                            }}
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
                  {streamingContent}
                </ReactMarkdown>
                <span className="typing-cursor">▊</span>
              </div>
            </div>
          </div>
        )}
        
        {loading && !streamingContent && (
          <div style={{
            marginBottom: '1.5rem',
            display: 'flex',
            justifyContent: 'flex-start',
          }}>
            <div style={{
              maxWidth: '85%',
              background: 'white',
              padding: '1rem 1.25rem',
              borderRadius: '12px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              color: '#6b7280',
            }}>
              <div className="thinking-dots">
                <span>●</span>
                <span>●</span>
                <span>●</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>
                  {currentActivity || 'Analyzing your environment...'}
                </span>
                {currentActivity && (
                  <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                    Gathering information
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>
      
      {/* Input Area */}
      <form 
        onSubmit={handleSubmit} 
        style={{ 
          padding: '1.5rem', 
          borderTop: '1px solid #e5e7eb', 
          background: 'white',
        }}
      >
        <div style={{ 
          display: 'flex', 
          gap: '0.75rem',
          alignItems: 'flex-start',
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoResizeTextarea();
            }}
            placeholder="Ask anything... (e.g., Why is my service failing?)"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            disabled={loading}
            rows={1}
            style={{
              flex: 1,
              padding: '0.875rem 1rem',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              fontFamily: 'inherit',
              fontSize: '0.9375rem',
              resize: 'none',
              outline: 'none',
              transition: 'all 0.2s',
              minHeight: '44px',
              maxHeight: '120px',
              background: '#fafafa',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = '#667eea';
              e.currentTarget.style.background = 'white';
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(102, 126, 234, 0.1)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = '#e5e7eb';
              e.currentTarget.style.background = '#fafafa';
              e.currentTarget.style.boxShadow = 'none';
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            style={{
              padding: '0.875rem 1.5rem',
              background: !input.trim() || loading 
                ? '#e5e7eb' 
                : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: !input.trim() || loading ? '#9ca3af' : 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: !input.trim() || loading ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              fontWeight: 600,
              transition: 'all 0.2s',
              boxShadow: !input.trim() || loading ? 'none' : '0 2px 8px rgba(102, 126, 234, 0.3)',
              minWidth: '100px',
              height: '44px',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              if (input.trim() && !loading) {
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.4)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = !input.trim() || loading ? 'none' : '0 2px 8px rgba(102, 126, 234, 0.3)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            {loading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span className="spinner"></span>
                <span>{streaming && streamingContent ? 'Receiving' : 'Analyzing'}</span>
              </span>
            ) : (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>Send</span>
                <span style={{ fontSize: '1rem' }}>→</span>
              </span>
            )}
          </button>
        </div>
        <div style={{ 
          marginTop: '0.75rem', 
          fontSize: '0.75rem', 
          color: '#9ca3af',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}>
          <span>💡</span>
          <span>Press Enter to send, Shift+Enter for new line</span>
        </div>
      </form>
      
      <style jsx global>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }

        @keyframes thinking {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
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
        
        .spinner {
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255, 255, 255, 0.3);
          border-top-color: white;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }
        
        .ai-message-content {
          line-height: 1.7;
          font-size: 14px;
          color: #1f2937;
        }

        .user-message-content {
          line-height: 1.7;
          font-size: 14px;
          color: white;
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
    </div>
  );
}

