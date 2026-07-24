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
  serializeSocketHttpResponse,
  classifyEditorProxyFailure,
  resolveEditorProxyFailureMapping,
  buildWorkspaceEditorErrorPage,
  isEditorNavigationRequest,
  editorProxyConnections,
  EDITOR_PROXY_MAX_PER_SESSION,
} from '../workspaceEditorProxy';

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

  describe('classifyEditorProxyFailure', () => {
    it('maps explicit coded errors', () => {
      expect(classifyEditorProxyFailure(new Error('editor-proxy-timeout'))).toBe('timeout');
      expect(classifyEditorProxyFailure(new Error('editor-proxy-capacity'))).toBe('capacity');
    });

    it('maps auth failures', () => {
      expect(classifyEditorProxyFailure(new Error('Authentication token is required'))).toBe('auth');
      expect(classifyEditorProxyFailure(new Error('Forbidden: you do not own this session'))).toBe('auth');
    });

    it('prefers a suspended workspace over a missing pod', () => {
      expect(classifyEditorProxyFailure(new Error('Workspace is not ready'), { workspaceUnavailable: true })).toBe(
        'workspace-suspended'
      );
    });

    it('maps a missing pod / not-found to pod-gone', () => {
      expect(classifyEditorProxyFailure(new Error('Session not found or not active'), { podMissing: true })).toBe(
        'pod-gone'
      );
      expect(classifyEditorProxyFailure(new Error('Session not found or not active'))).toBe('pod-gone');
    });

    it('maps socket error codes and unknowns to unreachable', () => {
      expect(classifyEditorProxyFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('unreachable');
      expect(classifyEditorProxyFailure(new Error('something weird'))).toBe('unreachable');
    });
  });

  describe('resolveEditorProxyFailureMapping', () => {
    it('maps reasons to the documented status codes', () => {
      expect(resolveEditorProxyFailureMapping('auth').status).toBe(401);
      expect(resolveEditorProxyFailureMapping('workspace-suspended').status).toBe(409);
      expect(resolveEditorProxyFailureMapping('pod-gone').status).toBe(410);
      expect(resolveEditorProxyFailureMapping('unreachable').status).toBe(502);
      expect(resolveEditorProxyFailureMapping('timeout').status).toBe(504);
      expect(resolveEditorProxyFailureMapping('capacity').status).toBe(503);
    });
  });

  describe('isEditorNavigationRequest', () => {
    it('detects html navigations and rejects asset/ws requests', () => {
      expect(isEditorNavigationRequest({ accept: 'text/html,application/xhtml+xml' })).toBe(true);
      expect(isEditorNavigationRequest({ accept: 'application/json' })).toBe(false);
      expect(isEditorNavigationRequest({})).toBe(false);
    });
  });

  describe('buildWorkspaceEditorErrorPage', () => {
    it('renders a branded page with an escaped deep-link CTA', () => {
      const html = buildWorkspaceEditorErrorPage({
        reason: 'workspace-suspended',
        sessionUrl: 'https://lfc.test/new/abc?x="1"',
      });
      expect(html).toContain('Workspace suspended');
      expect(html).toContain('Resume workspace');
      // URL quotes must be escaped so they cannot break out of the href attribute.
      expect(html).toContain('href="https://lfc.test/new/abc?x=&quot;1&quot;"');
      expect(html).not.toContain('x="1"');
    });
  });

  describe('editorProxyConnections registry', () => {
    const sessionId = 'registry-test-session';

    afterEach(() => {
      // Drain any leftover tokens between cases.
      while (editorProxyConnections.sizeForSession(sessionId) > 0) {
        // no-op: tokens released within each test
        break;
      }
    });

    it('registers and releases, keeping the gauge consistent', () => {
      const before = editorProxyConnections.size();
      const a = {};
      const b = {};
      expect(editorProxyConnections.tryRegister(sessionId, a)).toBe(true);
      expect(editorProxyConnections.tryRegister(sessionId, b)).toBe(true);
      expect(editorProxyConnections.sizeForSession(sessionId)).toBe(2);
      expect(editorProxyConnections.size()).toBe(before + 2);
      editorProxyConnections.release(sessionId, a);
      editorProxyConnections.release(sessionId, b);
      expect(editorProxyConnections.sizeForSession(sessionId)).toBe(0);
      expect(editorProxyConnections.size()).toBe(before);
    });

    it('rejects once the per-session cap is reached', () => {
      const tokens: object[] = [];
      for (let i = 0; i < EDITOR_PROXY_MAX_PER_SESSION; i += 1) {
        const token = {};
        tokens.push(token);
        expect(editorProxyConnections.tryRegister(sessionId, token)).toBe(true);
      }
      expect(editorProxyConnections.tryRegister(sessionId, {})).toBe(false);
      tokens.forEach((token) => editorProxyConnections.release(sessionId, token));
      expect(editorProxyConnections.sizeForSession(sessionId)).toBe(0);
    });
  });
});
