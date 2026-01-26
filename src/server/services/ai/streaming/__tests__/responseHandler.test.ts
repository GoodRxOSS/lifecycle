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

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { ResponseHandler } from '../responseHandler';

describe('ResponseHandler', () => {
  let handler: ResponseHandler;
  let onThinking: jest.Mock;
  let onTextChunk: jest.Mock;

  beforeEach(() => {
    onThinking = jest.fn();
    onTextChunk = jest.fn();
    handler = new ResponseHandler(
      {
        onThinking,
        onTextChunk,
        onToolCall: jest.fn(),
        onToolResult: jest.fn(),
        onComplete: jest.fn(),
        onError: jest.fn(),
      },
      'test-uuid'
    );
  });

  it('returns plain text for non-JSON responses', () => {
    handler.handleChunk('Hello world');
    const result = handler.getResult();
    expect(result).toEqual({ response: 'Hello world', isJson: false });
    expect(onTextChunk).toHaveBeenCalledWith('Hello world');
  });

  it('detects JSON response when text starts with { and contains type', () => {
    handler.handleChunk('{"type": "investigation_complete", "summary": "done"}');
    const result = handler.getResult();
    expect(result.isJson).toBe(true);
    expect(onThinking).toHaveBeenCalledWith('Generating structured report...');
  });

  it('handles multi-chunk JSON', () => {
    handler.handleChunk('{"type": "invest');
    handler.handleChunk('igation_complete"}');
    const result = handler.getResult();
    expect(result.isJson).toBe(true);
    expect(result.response).toContain('{"type": "invest');
    expect(result.response).toContain('igation_complete"}');
  });

  it('detects JSON when first chunk is buffered then second triggers detection', () => {
    handler.handleChunk('{');
    handler.handleChunk('"type": "x"}');
    const result = handler.getResult();
    expect(result.isJson).toBe(true);
  });

  it('keeps plain text as non-JSON', () => {
    handler.handleChunk('Just a regular message');
    const result = handler.getResult();
    expect(result.isJson).toBe(false);
  });

  it('calls onTextChunk for every chunk', () => {
    handler.handleChunk('one');
    handler.handleChunk('two');
    handler.handleChunk('three');
    expect(onTextChunk).toHaveBeenCalledTimes(3);
  });
});
