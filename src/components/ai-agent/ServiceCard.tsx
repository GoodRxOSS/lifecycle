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
import { Button, Card, CardHeader, CardBody, Chip, Divider, Skeleton } from '@heroui/react';
import { buildGitHubUrl, parseSuggestedFix } from './utils';
import { getStatusColor, getStatusLabel } from './statusUtils';
import type { ServiceInvestigationResult, EvidenceItem } from './types';

function renderFileLink(
  filePath: string,
  repository?: { owner: string; name: string; branch: string },
  lineStart?: number,
  lineEnd?: number
) {
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
}

function renderCommitLink(commitUrl: string) {
  return (
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
}

function renderDiffLines(oldContent: string, newContent: string) {
  return (
    <div className="font-mono text-sm space-y-1">
      <div className="bg-danger-50 border-l-4 border-danger px-3 py-2 rounded">
        <span className="text-danger-900">- {oldContent}</span>
      </div>
      <div className="bg-success-50 border-l-4 border-success px-3 py-2 rounded">
        <span className="text-success-900">+ {newContent}</span>
      </div>
    </div>
  );
}

function renderMultiLineDiff(currentLines: string[], shouldBeLines: string[]) {
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
}

export function ServiceCard({
  service,
  fixesApplied,
  repository,
  onAutoFix,
  loading,
  evidence,
  onHighlightActivity,
}: {
  service: ServiceInvestigationResult;
  fixesApplied: boolean;
  repository?: { owner: string; name: string; branch: string };
  onAutoFix: (service: ServiceInvestigationResult) => void;
  loading: boolean;
  evidence?: EvidenceItem[];
  onHighlightActivity?: (toolCallId: string) => void;
}) {
  const parsedFix = parseSuggestedFix(service.suggestedFix);
  const hasMultipleFiles = service.files && service.files.length > 0;
  const [showDetails, setShowDetails] = useState(false);
  const [expanded, setExpanded] = useState(false);

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
    <Card className="mb-4 border border-gray-200 shadow-sm">
      <CardHeader
        className="cursor-pointer hover:bg-gray-50/50 transition-colors py-3 px-5 bg-gray-50/80 border-b border-gray-200"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="w-full flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-base font-bold text-gray-900">{service.serviceName || <Skeleton className="h-5 w-32 rounded-lg inline-block" />}</h4>
              <Chip size="sm" variant="flat" color={getStatusColor(service.status)}>
                {getStatusLabel(service.status)}
              </Chip>
            </div>
            <p className="text-sm text-gray-600 line-clamp-1">{service.issue || <Skeleton className="h-3 w-48 rounded-lg" />}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!fixesApplied && service.canAutoFix && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onAutoFix(service);
                }}
                isDisabled={loading}
                size="md"
                color="success"
                variant="shadow"
                className="font-bold"
              >
                Fix it for me
              </Button>
            )}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            >
              <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
            </svg>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardBody className="p-6 space-y-6">
          <div className="space-y-3">
            <h5 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Root Cause</h5>
            <p className="text-base text-gray-800 leading-relaxed font-medium">{service.issue}</p>
            {(service.errorSource || service.errorSourceDetail) && (
              <p className="text-sm text-gray-600">
                {service.errorSource && <><span className="font-semibold">Source:</span> {service.errorSource}</>}
                {service.errorSource && service.errorSourceDetail && ' — '}
                {service.errorSourceDetail}
              </p>
            )}
            {service.filePath && (
              <div>
                {renderFileLink(service.filePath, repository, service.lineNumber, service.lineNumberEnd)}
              </div>
            )}
          </div>

          {service.keyError && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h5 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Error Output</h5>
                <Button
                  size="sm"
                  variant="light"
                  onClick={() => setShowDetails(!showDetails)}
                  className="text-xs"
                >
                  {showDetails ? 'Hide' : 'Show'} raw output
                </Button>
              </div>
              <div className="bg-danger-50 border-l-4 border-danger p-4 rounded-lg">
                <pre className="text-sm text-danger-900 overflow-x-auto m-0 leading-relaxed font-mono whitespace-pre-wrap">
                  {showDetails ? service.keyError : service.keyError.length > 200 ? service.keyError.slice(0, 200) + '...' : service.keyError}
                </pre>
              </div>
            </div>
          )}

          <Divider className="my-4" />

          <div className={fixesApplied ? 'bg-success-50 border-l-4 border-success p-4 rounded' : ''}>
            <div className="mb-4">
              <h5 className={`text-base font-bold ${fixesApplied ? 'text-success-800' : 'text-gray-900'}`}>
                {fixesApplied ? '\u2713 Fix Applied' : 'Suggested Fix'}
              </h5>
            </div>
            {hasMultipleFiles ? (
              <div className="space-y-4">
                <div className="flex gap-2 items-center">
                  <Chip size="sm" variant="flat" color="primary">
                    {service.files!.length} file{service.files!.length > 1 ? 's' : ''}
                  </Chip>
                  <span className="text-sm text-gray-600">to update</span>
                </div>
                {service.files!.map((file, idx) => (
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
          {evidence && evidence.length > 0 && (
            <>
              <Divider className="my-4" />
              <div className="space-y-2">
                <h5 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Evidence</h5>
                {evidence.filter((e) => e.type === 'evidence_file').length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {evidence
                      .filter((e) => e.type === 'evidence_file')
                      .map((item, idx) => (
                        <Chip
                          key={`ev-file-${idx}`}
                          as={repository || item.repository ? 'a' : undefined}
                          href={
                            item.filePath
                              ? buildGitHubUrl(
                                  item.repository
                                    ? {
                                        owner: item.repository.split('/')[0],
                                        name: item.repository.split('/')[1],
                                        branch: item.branch || repository?.branch || 'main',
                                      }
                                    : repository || { owner: '', name: '', branch: 'main' },
                                  item.filePath,
                                  item.lineStart,
                                  item.lineEnd
                                )
                              : undefined
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="flat"
                          color="primary"
                          size="sm"
                          className={`font-mono text-xs ${item.toolCallId && onHighlightActivity ? 'cursor-pointer' : ''}`}
                          onClick={() => item.toolCallId && onHighlightActivity?.(item.toolCallId)}
                        >
                          {item.filePath}
                        </Chip>
                      ))}
                  </div>
                )}
                {evidence
                  .filter((e) => e.type === 'evidence_commit')
                  .map((item, idx) => (
                    <div key={`ev-commit-${idx}`} className="flex items-center gap-2">
                      <span className="text-xs text-gray-700 truncate max-w-[300px]">
                        {item.commitMessage && item.commitMessage.length > 60
                          ? item.commitMessage.substring(0, 60) + '...'
                          : item.commitMessage}
                      </span>
                      {item.commitUrl && (
                        <Chip
                          as="a"
                          href={item.commitUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="flat"
                          color="success"
                          size="sm"
                          className="cursor-pointer"
                        >
                          View Commit
                        </Chip>
                      )}
                    </div>
                  ))}
                {evidence.filter((e) => e.type === 'evidence_resource').length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {evidence
                      .filter((e) => e.type === 'evidence_resource')
                      .map((item, idx) => (
                        <Chip
                          key={`ev-res-${idx}`}
                          variant="flat"
                          color="warning"
                          size="sm"
                          className={`font-mono text-xs ${item.toolCallId && onHighlightActivity ? 'cursor-pointer' : ''}`}
                          onClick={() => item.toolCallId && onHighlightActivity?.(item.toolCallId)}
                        >
                          {item.resourceType}/{item.resourceName}
                          {item.namespace ? ` in ${item.namespace}` : ''}
                        </Chip>
                      ))}
                  </div>
                )}
              </div>
            </>
          )}
        </CardBody>
      )}
    </Card>
  );
}
