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
        onActivity: jest.fn(),
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

  it('calls onTextChunk for plain text chunks', () => {
    handler.handleChunk('one');
    handler.handleChunk('two');
    handler.handleChunk('three');
    expect(onTextChunk).toHaveBeenCalledTimes(3);
  });

  it('detects markdown-fenced JSON', () => {
    handler.handleChunk('```json\n{"type": "investigation_complete", "summary": "done"}\n```');
    const result = handler.getResult();
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ type: 'investigation_complete', summary: 'done' });
  });

  it('detects preamble text + fenced JSON', () => {
    handler.handleChunk('Here are the findings:\n\n```json\n{"type": "investigation_complete", "data": []}\n```');
    const result = handler.getResult();
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ type: 'investigation_complete', data: [] });
  });

  it('detects fenced JSON without json language tag', () => {
    handler.handleChunk('```\n{"type": "investigation_complete"}\n```');
    const result = handler.getResult();
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ type: 'investigation_complete' });
  });

  it('strips trailing fence markers from getResult', () => {
    handler.handleChunk('```json\n{"type": "x"}');
    handler.handleChunk('\n```');
    const result = handler.getResult();
    expect(result.isJson).toBe(true);
    expect(result.response).not.toContain('```');
  });

  describe('JSON chunk suppression', () => {
    it('does not call onTextChunk for JSON content chunks', () => {
      handler.handleChunk('{"type": "investigation_complete", "summary": "done"}');
      expect(onTextChunk).not.toHaveBeenCalled();
    });

    it('does not leak partial JSON prefix when type arrives in later chunk', () => {
      handler.handleChunk('{');
      handler.handleChunk('"type": "investigation_complete"}');
      expect(onTextChunk).not.toHaveBeenCalled();
    });

    it('does not call onTextChunk for subsequent JSON chunks', () => {
      handler.handleChunk('{"type": "invest');
      handler.handleChunk('igation_complete"}');
      expect(onTextChunk).not.toHaveBeenCalled();
    });

    it('does not call onTextChunk for fenced JSON', () => {
      handler.handleChunk('```json\n{"type": "investigation_complete"}\n```');
      expect(onTextChunk).not.toHaveBeenCalled();
    });

    it('sends preamble via onTextChunk but suppresses JSON', () => {
      handler.handleChunk('Here is my analysis:\n\n```json\n{"type": "investigation_complete"}\n```');
      const calls = onTextChunk.mock.calls.map((c: any[]) => c[0]);
      const allText = calls.join('');
      expect(allText).not.toContain('"investigation_complete"');
      expect(allText).not.toContain('{');
    });

    it('emits plain-text preamble and suppresses split raw JSON tail', () => {
      handler.handleChunk('Analysis complete.\n{');
      handler.handleChunk('"type": "investigation_complete", "services": []}');

      const calls = onTextChunk.mock.calls.map((c: any[]) => c[0]);
      const allText = calls.join('');
      expect(allText).toContain('Analysis complete.');
      expect(allText).not.toContain('"investigation_complete"');
      expect(allText).not.toContain('{');
    });
  });

  describe('preamble tracking', () => {
    it('returns preamble for mixed text+JSON responses', () => {
      handler.handleChunk('Here are the findings:\n\n```json\n{"type": "investigation_complete", "data": []}\n```');
      const result = handler.getResult();
      expect(result.isJson).toBe(true);
      expect(result.preamble).toBe('Here are the findings:');
    });

    it('does not return preamble for pure JSON responses', () => {
      handler.handleChunk('{"type": "investigation_complete", "summary": "done"}');
      const result = handler.getResult();
      expect(result.isJson).toBe(true);
      expect(result.preamble).toBeUndefined();
    });

    it('does not return preamble for plain text', () => {
      handler.handleChunk('Just a regular message');
      const result = handler.getResult();
      expect(result.isJson).toBe(false);
      expect(result.preamble).toBeUndefined();
    });

    it('does not return preamble for fenced JSON without preamble text', () => {
      handler.handleChunk('```json\n{"type": "investigation_complete"}\n```');
      const result = handler.getResult();
      expect(result.isJson).toBe(true);
      expect(result.preamble).toBeUndefined();
    });
  });
});
