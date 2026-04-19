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

import { buildWorkspaceEditorProxyHeaders, serializeSocketHttpResponse } from '../workspaceEditorProxy';

describe('workspaceEditorProxy', () => {
  it('drops hop-by-hop headers for plain HTTP proxy requests', () => {
    expect(
      buildWorkspaceEditorProxyHeaders({
        requestHeaders: {
          host: 'localhost:5001',
          connection: 'Upgrade',
          upgrade: 'websocket',
          origin: 'http://localhost:5001',
          cookie: 'sample=1',
        },
        targetHost: 'agent.sample.svc.cluster.local:13337',
        forwardedHost: 'localhost:5001',
        forwardedProto: 'http',
        forwardedPrefix: '/api/agent-session/workspace-editor/sample',
        remoteAddress: '127.0.0.1',
      })
    ).toEqual({
      cookie: 'sample=1',
      origin: 'http://localhost:5001',
      host: 'agent.sample.svc.cluster.local:13337',
      'x-forwarded-host': 'localhost:5001',
      'x-forwarded-proto': 'http',
      'x-forwarded-prefix': '/api/agent-session/workspace-editor/sample',
      'x-forwarded-for': '127.0.0.1',
    });
  });

  it('preserves websocket upgrade headers for raw upgrade proxying', () => {
    expect(
      buildWorkspaceEditorProxyHeaders({
        requestHeaders: {
          host: 'localhost:5001',
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'sample-key',
          'sec-websocket-version': '13',
        },
        targetHost: 'agent.sample.svc.cluster.local:13337',
        forwardedHost: 'localhost:5001',
        forwardedProto: 'http',
        forwardedPrefix: '/api/agent-session/workspace-editor/sample',
        includeUpgradeHeaders: true,
      })
    ).toEqual(
      expect.objectContaining({
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'sample-key',
        'sec-websocket-version': '13',
        host: 'agent.sample.svc.cluster.local:13337',
      })
    );
  });

  it('serializes upgrade responses with repeated headers', () => {
    expect(
      serializeSocketHttpResponse({
        statusCode: 101,
        statusMessage: 'Switching Protocols',
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Set-Cookie': ['a=1', 'b=2'],
        },
      }).toString('utf8')
    ).toBe(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n'
    );
  });

  it('adds content-length for non-empty error responses', () => {
    expect(
      serializeSocketHttpResponse({
        statusCode: 502,
        statusMessage: 'Bad Gateway',
        body: 'editor unavailable',
      }).toString('utf8')
    ).toBe('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 18\r\n\r\neditor unavailable');
  });
});
