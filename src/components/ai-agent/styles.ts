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

export const globalStyles = `
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

  .highlighted-line {
    background-color: rgba(239, 68, 68, 0.2);
    display: block;
    border-left: 3px solid #ef4444;
    padding-left: 8px;
  }
`;
