/**
 * Copyright 2026 GoodRx, Inc.
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

import { isStreamingInfo, type LogSourceStatus, type StreamingInfo } from './types';

const websocket = {
  endpoint: '/api/logs/stream',
  parameters: {
    podName: 'api-7d9f',
    namespace: 'lifecycle',
    follow: true,
    tailLines: 200,
    timestamps: true,
  },
};

describe('isStreamingInfo', () => {
  it.each(['Running', 'Pending'] as const)('recognizes a valid %s streaming response', (status) => {
    const response: StreamingInfo = {
      status,
      streamingRequired: true,
      websocket,
      containers: [{ name: 'api', state: status }],
    };

    expect(isStreamingInfo(response)).toBe(true);
  });

  it.each(['Completed', 'Failed', 'NotFound', 'Unavailable', 'NotApplicable', 'Unknown'] as const)(
    'rejects a terminal %s response',
    (status) => {
      const response: LogSourceStatus = {
        status,
        streamingRequired: false,
        message: 'No live stream is required.',
      };

      expect(isStreamingInfo(response)).toBe(false);
    }
  );

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a primitive', 'Running'],
    ['a missing websocket', { status: 'Running', streamingRequired: true }],
    ['a false streaming marker', { status: 'Running', streamingRequired: false, websocket }],
    ['a non-boolean streaming marker', { status: 'Running', streamingRequired: 'true', websocket }],
  ])('rejects malformed input with %s', (_case, response) => {
    expect(isStreamingInfo(response as StreamingInfo | LogSourceStatus)).toBeFalsy();
  });
});
