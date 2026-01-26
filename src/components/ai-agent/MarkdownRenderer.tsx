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

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import ShikiHighlighter, { isInlineCode, type Element } from 'react-shiki';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { autoLinkGitHubReferences } from './githubLinks';

interface MarkdownRendererProps {
  content: string;
  repositoryContext?: {
    owner: string;
    repo: string;
    sha: string;
  };
}

function createLineHighlightTransformer(lines: number[]) {
  return {
    line(this: { addClassToHast: (node: any, className: string) => void }, node: any, lineNumber: number) {
      if (lines.includes(lineNumber)) {
        this.addClassToHast(node, 'highlighted-line');
      }
    },
  };
}

function CodeHighlight({
  className,
  children,
  node,
  ...props
}: {
  className?: string;
  children?: React.ReactNode;
  node?: Element;
  [key: string]: any;
}) {
  const [codeCopied, setCodeCopied] = useState(false);
  const code = String(children).replace(/\n$/, '');
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : undefined;
  const isInline = node ? isInlineCode(node) : true;

  const fullMatch = /language-(\w+):(\d+)\{([\d,\s]+)\}/.exec(className || '');
  const simpleMatch = /language-(\w+)\{([\d,\s]+)\}/.exec(className || '');

  let startingLineNumber = 1;
  let highlightLines: number[] = [];

  if (fullMatch) {
    startingLineNumber = parseInt(fullMatch[2]);
    highlightLines = fullMatch[3].split(',').map((n) => parseInt(n.trim()));
  } else if (simpleMatch) {
    highlightLines = simpleMatch[2].split(',').map((n) => parseInt(n.trim()));
  }

  if (isInline || !language) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return (
    <div style={{ position: 'relative' }} className="group">
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
          } catch {
            const ta = document.createElement('textarea');
            ta.value = code;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          setCodeCopied(true);
          setTimeout(() => setCodeCopied(false), 2000);
        }}
        className="absolute top-2 right-2 z-10 px-2 py-1 rounded text-xs font-mono bg-gray-700 hover:bg-gray-600 text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {codeCopied ? 'Copied!' : 'Copy'}
      </button>
      <ShikiHighlighter
        language={language}
        theme="one-dark-pro"
        addDefaultStyles={false}
        showLineNumbers={highlightLines.length > 0}
        startingLineNumber={startingLineNumber}
        transformers={highlightLines.length > 0 ? [createLineHighlightTransformer(highlightLines)] : undefined}
      >
        {code}
      </ShikiHighlighter>
    </div>
  );
}

export function MarkdownRenderer({ content, repositoryContext }: MarkdownRendererProps) {
  const processedContent = repositoryContext
    ? autoLinkGitHubReferences(content, repositoryContext)
    : content;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      components={{
        code: CodeHighlight as any,
        a({ children, href, ...props }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          );
        },
      }}
    >
      {processedContent}
    </ReactMarkdown>
  );
}
