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

import {
  buildWorkspaceEditorProxyHeaders,
  classifyEditorProxyFailure,
  isEditorNavigationRequest,
  serializeSocketHttpResponse,
} from '../workspaceEditorProxy';

describe('workspace editor proxy boundary behavior', () => {
  it('normalizes valid multi-value headers and omits absent request headers', () => {
    expect(
      buildWorkspaceEditorProxyHeaders({
        requestHeaders: {
          'x-optional': undefined,
          'x-editor-feature': ['terminal', 'files'],
          'x-forwarded-for': '192.0.2.10',
        },
        targetHost: 'agent.session.svc.cluster.local:13337',
        forwardedHost: '',
        forwardedProto: 'https',
        forwardedPrefix: '/api/agent-session/workspace-editor/session-1',
        remoteAddress: '198.51.100.20',
        includeUpgradeHeaders: true,
      })
    ).toEqual({
      'x-editor-feature': 'terminal, files',
      'x-forwarded-for': '192.0.2.10, 198.51.100.20',
      host: 'agent.session.svc.cluster.local:13337',
      'x-forwarded-host': 'agent.session.svc.cluster.local:13337',
      'x-forwarded-proto': 'https',
      'x-forwarded-prefix': '/api/agent-session/workspace-editor/session-1',
      connection: 'Upgrade',
      upgrade: 'websocket',
    });
  });

  it('preserves an upstream content length while omitting absent response headers', () => {
    const response = serializeSocketHttpResponse({
      statusCode: 200,
      headers: {
        'x-optional': undefined,
        'Content-Length': '3',
      },
      body: Buffer.from('abc'),
    }).toString('utf8');

    expect(response).toBe('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc');
    expect(response.match(/Content-Length/g)).toHaveLength(1);
  });

  it('uses a stable status message for a valid non-standard upstream status', () => {
    expect(serializeSocketHttpResponse({ statusCode: 599 }).toString('utf8')).toBe('HTTP/1.1 599 Unknown\r\n\r\n');
  });

  it('classifies non-Error failure values accepted by the public unknown contract', () => {
    expect(classifyEditorProxyFailure('Forbidden by workspace policy')).toBe('auth');
    expect(classifyEditorProxyFailure(null)).toBe('unreachable');
    expect(classifyEditorProxyFailure(undefined)).toBe('unreachable');
  });

  it('detects an HTML navigation in a comma-separated Accept header', () => {
    expect(isEditorNavigationRequest({ accept: 'application/json, text/html' })).toBe(true);
  });

  it('rejects the configured global cap and ignores release of an unknown connection', () => {
    const globalLimitKey = 'AGENT_SESSION_EDITOR_PROXY_MAX_GLOBAL';
    const sessionLimitKey = 'AGENT_SESSION_EDITOR_PROXY_MAX_PER_SESSION';
    const previousGlobalLimit = process.env[globalLimitKey];
    const previousSessionLimit = process.env[sessionLimitKey];

    try {
      process.env[globalLimitKey] = '2';
      process.env[sessionLimitKey] = '2';

      let isolatedModule: typeof import('../workspaceEditorProxy');
      jest.isolateModules(() => {
        isolatedModule = require('../workspaceEditorProxy');
      });

      const registry = isolatedModule!.editorProxyConnections;
      const first = {};
      const second = {};
      const rejected = {};

      registry.release('missing-session', rejected);
      expect(registry.size()).toBe(0);

      expect(registry.tryRegister('session-1', first)).toBe(true);
      expect(registry.tryRegister('session-2', second)).toBe(true);
      expect(registry.tryRegister('session-3', rejected)).toBe(false);
      expect(registry.size()).toBe(2);
      expect(registry.sizeForSession('session-3')).toBe(0);

      registry.release('session-1', first);
      registry.release('session-2', second);
      expect(registry.size()).toBe(0);
    } finally {
      if (previousGlobalLimit === undefined) {
        delete process.env[globalLimitKey];
      } else {
        process.env[globalLimitKey] = previousGlobalLimit;
      }

      if (previousSessionLimit === undefined) {
        delete process.env[sessionLimitKey];
      } else {
        process.env[sessionLimitKey] = previousSessionLimit;
      }
    }
  });
});
