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
import { extractJsonFromResponse } from '../../utils/jsonExtraction';

/**
 * Simulates the post-processing logic from the route handler (lines 474-516 of route.ts).
 * Given a ResponseHandler result, applies the same complete_json emission logic.
 */
function simulateRoutePostProcessing(result: { response: string; isJson: boolean }) {
  const events: Array<{ type: string; content?: string }> = [];
  let aiResponse = result.response;
  let isJsonResponse = result.isJson;

  // Late JSON detection fallback (route.ts lines 474-478)
  if (!isJsonResponse && aiResponse.includes('"investigation_complete"')) {
    const extracted = extractJsonFromResponse(aiResponse, 'test-uuid');
    aiResponse = extracted.response;
    isJsonResponse = extracted.isJson;
  }

  // JSON validation and complete_json emission (route.ts lines 480-516)
  if (isJsonResponse) {
    try {
      JSON.parse(aiResponse);
      events.push({ type: 'complete_json', content: aiResponse });
    } catch {
      isJsonResponse = false;
    }
  }

  events.push({ type: 'complete' });

  return { events, aiResponse, isJsonResponse };
}

function createHandler() {
  return new ResponseHandler(
    {
      onThinking: jest.fn(),
      onTextChunk: jest.fn(),
      onToolCall: jest.fn(),
      onToolResult: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    },
    'test-uuid'
  );
}

describe('complete_json emission', () => {
  it('emits complete_json for direct JSON investigation response', () => {
    const handler = createHandler();
    const json = '{"type": "investigation_complete", "summary": "done", "services": []}';
    handler.handleChunk(json);
    const { events, isJsonResponse } = simulateRoutePostProcessing(handler.getResult());

    expect(isJsonResponse).toBe(true);
    expect(events[0].type).toBe('complete_json');
    expect(events[1].type).toBe('complete');
    expect(JSON.parse(events[0].content!).type).toBe('investigation_complete');
  });

  it('emits complete_json for fenced JSON investigation response', () => {
    const handler = createHandler();
    handler.handleChunk('```json\n{"type": "investigation_complete", "data": []}\n```');
    const { events, isJsonResponse } = simulateRoutePostProcessing(handler.getResult());

    expect(isJsonResponse).toBe(true);
    expect(events[0].type).toBe('complete_json');
    expect(events[1].type).toBe('complete');
    expect(JSON.parse(events[0].content!).type).toBe('investigation_complete');
  });

  it('emits complete_json for preamble + fenced JSON via late detection', () => {
    const handler = createHandler();
    handler.handleChunk('Here are the findings:\n\n```json\n{"type": "investigation_complete", "items": []}\n```');
    const { events, isJsonResponse } = simulateRoutePostProcessing(handler.getResult());

    expect(isJsonResponse).toBe(true);
    expect(events[0].type).toBe('complete_json');
    expect(events[1].type).toBe('complete');
    expect(JSON.parse(events[0].content!).type).toBe('investigation_complete');
  });

  it('content field is valid JSON in complete_json event', () => {
    const handler = createHandler();
    const json = '{"type": "investigation_complete", "nested": {"key": [1, 2]}}';
    handler.handleChunk(json);
    const { events } = simulateRoutePostProcessing(handler.getResult());

    const parsed = JSON.parse(events[0].content!);
    expect(parsed.type).toBe('investigation_complete');
    expect(parsed.nested.key).toEqual([1, 2]);
  });

  it('complete_json is emitted before complete', () => {
    const handler = createHandler();
    handler.handleChunk('{"type": "investigation_complete"}');
    const { events } = simulateRoutePostProcessing(handler.getResult());

    const jsonIdx = events.findIndex((e) => e.type === 'complete_json');
    const completeIdx = events.findIndex((e) => e.type === 'complete');
    expect(jsonIdx).toBeLessThan(completeIdx);
  });

  it('does not emit complete_json for plain text responses', () => {
    const handler = createHandler();
    handler.handleChunk('Just a regular chat message');
    const { events, isJsonResponse } = simulateRoutePostProcessing(handler.getResult());

    expect(isJsonResponse).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');
  });
});
