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

type Listener = (...args: any[]) => unknown;

const mockNextHandler = jest.fn();
const mockPrepare = jest.fn(() => Promise.resolve());
const mockMcpHttpRequestHandler = jest.fn();
const mockRegistry = { kind: 'lifecycle-mcp-registry' };
const mockCreateLifecycleMcpRegistry = jest.fn(() => mockRegistry);
const mockStreamK8sLogs = jest.fn();
const mockParseChatPreviewHost = jest.fn();
const mockResolveChatPreviewSessionForHost = jest.fn();
const mockMatchesGatewayHost = jest.fn();
const mockGetGatewayObject = jest.fn();
const mockAgentSessionGetSession = jest.fn();
const mockVerifyBearerToken = jest.fn();
const mockAgentSessionFindOne = jest.fn();
const mockAgentSessionFindById = jest.fn();
const mockAgentSessionQuery = jest.fn(() => ({
  findById: mockAgentSessionFindById,
  findOne: mockAgentSessionFindOne,
}));
const mockAgentSandboxFindById = jest.fn();
const mockAgentSandboxQuery = jest.fn(() => ({ findById: mockAgentSandboxFindById }));
const mockExposureFirst = jest.fn();
const mockExposureQuery = jest.fn();
const mockResolveWorkspaceEditorEndpoint = jest.fn();
const mockRestorePreviewExposures = jest.fn();
const mockResolvePersistedPreviewEndpointWithAuth = jest.fn();
const mockTryRegisterEditorConnection = jest.fn();
const mockReleaseEditorConnection = jest.fn();
const mockClassifyEditorProxyFailure = jest.fn();
const mockResolveEditorProxyFailureMapping = jest.fn();
const mockBuildWorkspaceEditorErrorPage = jest.fn();
const mockIsEditorNavigationRequest = jest.fn();
const mockSerializeSocketHttpResponse = jest.fn();
const mockAppendForwardQuery = jest.fn();
const mockBuildChatPreviewAuthRedirectUrl = jest.fn();
const mockBuildChatPreviewCookie = jest.fn();
const mockBuildProxyHeaders = jest.fn();
const mockBuildRemoteTargetUrl = jest.fn();
const mockParseCookieHeader = jest.fn();
const mockRewritePreviewResponseHeader = jest.fn();
const mockStripPreviewBootstrapParams = jest.fn();
const mockStripQueryParamsFromRequestUrl = jest.fn();
const mockVerifyChatPreviewGrant = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
const mockHttpRequest = jest.fn();
const mockHttpsRequest = jest.fn();
const mockServerListeners: Record<string, Listener> = {};
const mockWssListeners: Record<string, Listener> = {};
let mockHttpHandler: Listener | undefined;
let mockLifecycleMode = 'web';

const mockHttpServer = {
  listen: jest.fn(),
  on: jest.fn((event: string, listener: Listener) => {
    mockServerListeners[event] = listener;
    return mockHttpServer;
  }),
};
const mockWss = {
  emit: jest.fn(),
  handleUpgrade: jest.fn(),
  on: jest.fn((event: string, listener: Listener) => {
    mockWssListeners[event] = listener;
    return mockWss;
  }),
};
const mockCreateServer = jest.fn((handler: Listener) => {
  mockHttpHandler = handler;
  return mockHttpServer;
});
const mockWebSocketServer = jest.fn(() => mockWss);

jest.mock('module-alias/register', () => ({}));
jest.mock('module-alias', () => ({
  __esModule: true,
  default: { addAliases: jest.fn() },
}));
jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return {
    ...actual,
    createServer: mockCreateServer,
    request: mockHttpRequest,
  };
});
jest.mock('https', () => ({ request: mockHttpsRequest }));
jest.mock('next', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getRequestHandler: () => mockNextHandler,
    prepare: mockPrepare,
  })),
}));
jest.mock('ws', () => ({
  WebSocketServer: mockWebSocketServer,
  WebSocket: { CONNECTING: 0, OPEN: 1 },
}));
jest.mock('./src/server/lib/logger', () => ({
  rootLogger: { child: jest.fn(() => mockLogger) },
}));
jest.mock('./src/shared/config', () => ({ LIFECYCLE_MODE: mockLifecycleMode }));
jest.mock('./src/server/mcp/config', () => ({ isMcpServingProcess: jest.fn(() => true) }));
jest.mock('./src/server/mcp/handler', () => ({ handleMcpHttpRequest: mockMcpHttpRequestHandler }));
jest.mock('./src/server/mcp/tools', () => ({ createLifecycleMcpRegistry: mockCreateLifecycleMcpRegistry }));
jest.mock('./src/server/lib/k8sStreamer', () => ({ streamK8sLogs: mockStreamK8sLogs }));
jest.mock('./src/server/services/sites', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getGatewayObject: mockGetGatewayObject,
    matchesGatewayHost: mockMatchesGatewayHost,
  })),
}));
jest.mock('./src/server/lib/agentSession/workspaceEditorProxy', () => ({
  EDITOR_PROXY_PING_INTERVAL_MS: 10_000,
  EDITOR_PROXY_PONG_DEADLINE_MS: 5_000,
  EDITOR_PROXY_TIMEOUT_MS: 30_000,
  buildWorkspaceEditorErrorPage: mockBuildWorkspaceEditorErrorPage,
  classifyEditorProxyFailure: mockClassifyEditorProxyFailure,
  editorProxyConnections: {
    release: mockReleaseEditorConnection,
    size: jest.fn(() => 0),
    tryRegister: mockTryRegisterEditorConnection,
  },
  isEditorNavigationRequest: mockIsEditorNavigationRequest,
  resolveEditorProxyFailureMapping: mockResolveEditorProxyFailureMapping,
  serializeSocketHttpResponse: mockSerializeSocketHttpResponse,
}));
jest.mock('./src/server/lib/agentSession/chatPreviewProxy', () => ({
  CHAT_PREVIEW_COOKIE_NAME: 'preview-cookie',
  EDITOR_PROXY_BLOCKED_QUERY_PARAMS: new Set(['token']),
  HOP_BY_HOP_HEADERS: new Set(['connection']),
  PREVIEW_PROXY_BLOCKED_QUERY_PARAMS: new Set(['grant', 'previewHost', 'token']),
  appendForwardQuery: mockAppendForwardQuery,
  buildChatPreviewAuthRedirectUrl: mockBuildChatPreviewAuthRedirectUrl,
  buildChatPreviewCookie: mockBuildChatPreviewCookie,
  buildProxyHeaders: mockBuildProxyHeaders,
  buildRemoteTargetUrl: mockBuildRemoteTargetUrl,
  parseCookieHeader: mockParseCookieHeader,
  rewritePreviewResponseHeader: mockRewritePreviewResponseHeader,
  stripPreviewBootstrapParams: mockStripPreviewBootstrapParams,
  stripQueryParamsFromRequestUrl: mockStripQueryParamsFromRequestUrl,
}));
jest.mock('./src/server/lib/agentSession/chatPreviewGrant', () => ({
  verifyChatPreviewGrant: mockVerifyChatPreviewGrant,
}));
jest.mock('./src/server/lib/agentSession/chatPreviewFactory', () => ({
  parseChatPreviewHost: mockParseChatPreviewHost,
}));
jest.mock('./src/server/lib/agentSession/chatPreviewHostResolver', () => ({
  resolveChatPreviewSessionForHost: mockResolveChatPreviewSessionForHost,
}));
jest.mock('./src/server/services/agentSession', () => ({
  __esModule: true,
  default: { getSession: mockAgentSessionGetSession },
}));
jest.mock('./src/server/lib/auth', () => ({ verifyBearerToken: mockVerifyBearerToken }));
jest.mock('./src/server/models/AgentSession', () => ({
  __esModule: true,
  default: { query: mockAgentSessionQuery },
}));
jest.mock('./src/server/models/AgentSandbox', () => ({
  __esModule: true,
  default: { query: mockAgentSandboxQuery },
}));
jest.mock('./src/server/models/AgentSandboxExposure', () => ({
  __esModule: true,
  default: { query: mockExposureQuery },
}));
jest.mock('./src/server/services/agent/SandboxService', () => ({
  __esModule: true,
  default: {
    resolveWorkspaceEditorEndpoint: mockResolveWorkspaceEditorEndpoint,
    restorePreviewExposures: mockRestorePreviewExposures,
  },
}));
jest.mock('./src/server/services/workspaceRuntime/gatewayPreview', () => ({
  resolvePersistedPreviewEndpointWithAuth: mockResolvePersistedPreviewEndpointWithAuth,
}));

function request(url: string) {
  return {
    headers: { host: 'lifecycle.test' },
    method: 'GET',
    on: jest.fn(),
    pipe: jest.fn(),
    socket: { remoteAddress: '127.0.0.1' },
    url,
  };
}

function response() {
  const headers = new Map<string, unknown>();
  return {
    end: jest.fn(),
    getHeader: jest.fn((name: string) => headers.get(name)),
    headersSent: false,
    setHeader: jest.fn((name: string, value: unknown) => headers.set(name, value)),
    statusCode: 200,
  };
}

function mockUpstreamResponse(
  options: { headers?: Record<string, string | string[]>; statusCode?: number } = {},
  requestMock = mockHttpRequest
) {
  const responseListeners: Record<string, Listener> = {};
  const proxyRequestListeners: Record<string, Listener> = {};
  const proxyResponse = {
    headers: options.headers || {},
    on: jest.fn((event: string, listener: Listener) => {
      responseListeners[event] = listener;
    }),
    pipe: jest.fn(() => {
      responseListeners.end?.();
    }),
    statusCode: options.statusCode ?? 200,
  };
  const proxyRequest = {
    destroy: jest.fn(),
    end: jest.fn(),
    on: jest.fn((event: string, listener: Listener) => {
      proxyRequestListeners[event] = listener;
    }),
    setTimeout: jest.fn(),
  };
  requestMock.mockImplementationOnce((_url, _options, callback: Listener) => {
    callback(proxyResponse);
    return proxyRequest;
  });
  return { proxyRequest, proxyResponse };
}

function mockUpstreamFailure(error: Error, requestMock = mockHttpRequest) {
  const proxyRequestListeners: Record<string, Listener> = {};
  const proxyRequest = {
    destroy: jest.fn(),
    end: jest.fn(() => proxyRequestListeners.error?.(error)),
    on: jest.fn((event: string, listener: Listener) => {
      proxyRequestListeners[event] = listener;
    }),
    setTimeout: jest.fn(),
  };
  requestMock.mockImplementationOnce(() => proxyRequest);
  return proxyRequest;
}

function mockUpgradeRequest(requestMock = mockHttpRequest) {
  const listeners: Record<string, Listener> = {};
  const proxyRequest = {
    destroy: jest.fn(),
    end: jest.fn(),
    on: jest.fn((event: string, listener: Listener) => {
      listeners[event] = listener;
    }),
    setTimeout: jest.fn(),
  };
  requestMock.mockImplementationOnce(() => proxyRequest);
  return { listeners, proxyRequest };
}

function rawSocket() {
  const listeners: Record<string, Listener[]> = {};
  const socket = {
    destroy: jest.fn(),
    destroyed: false,
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners[event] || [])]) listener(...args);
    },
    end: jest.fn(),
    listeners,
    on: jest.fn((event: string, listener: Listener) => {
      listeners[event] ||= [];
      listeners[event].push(listener);
      return socket;
    }),
    pipe: jest.fn(),
    removeListener: jest.fn((event: string, listener: Listener) => {
      listeners[event] = (listeners[event] || []).filter((candidate) => candidate !== listener);
      return socket;
    }),
    resume: jest.fn(),
    setTimeout: jest.fn(),
    write: jest.fn(),
  };
  socket.destroy.mockImplementation(() => {
    socket.destroyed = true;
    return socket;
  });
  return socket;
}

async function waitFor(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

function configurePreviewHost(sessionId = 'preview-session') {
  const hostMatch = { host: 'preview.example.test', port: 3001, previewSlug: 'app' };
  mockParseChatPreviewHost.mockReturnValue(hostMatch);
  mockResolveChatPreviewSessionForHost.mockResolvedValue({ sessionId });
  mockAgentSessionFindOne.mockResolvedValue({ userId: 'user-1' });
  mockAgentSandboxFindById.mockResolvedValue({ id: 21, sessionId: 11, status: 'ready' });
  mockAgentSessionFindById.mockResolvedValue({
    id: 11,
    status: 'active',
    uuid: sessionId,
    workspaceStatus: 'ready',
  });
  mockExposureFirst.mockResolvedValue({
    endedAt: null,
    id: 31,
    providerState: { workspaceId: 'workspace-1' },
    sandboxId: 21,
    status: 'ready',
  });
  mockResolvePersistedPreviewEndpointWithAuth.mockResolvedValue({
    headers: { 'x-workspace-token': 'secret' },
    url: 'http://workspace.gateway/base',
  });
  return hostMatch;
}

function webSocket(readyState = 1) {
  const listeners: Record<string, Listener> = {};
  return {
    close: jest.fn(),
    listeners,
    on: jest.fn((event: string, listener: Listener) => {
      listeners[event] = listener;
    }),
    readyState,
    send: jest.fn(),
  };
}

async function bootServer() {
  jest.resetModules();
  require('./ws-server');
  for (let attempt = 0; attempt < 5 && !mockHttpHandler; attempt += 1) {
    await Promise.resolve();
  }
  if (!mockHttpHandler) {
    throw new Error('ws-server did not register an HTTP handler');
  }
  return mockHttpHandler;
}

describe('ws-server public dispatch', () => {
  let setIntervalSpy: jest.SpyInstance;
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeAll(() => {
    setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockHttpHandler = undefined;
    for (const event of Object.keys(mockServerListeners)) delete mockServerListeners[event];
    for (const event of Object.keys(mockWssListeners)) delete mockWssListeners[event];
    mockMcpHttpRequestHandler.mockResolvedValue(false);
    mockNextHandler.mockResolvedValue(undefined);
    mockParseChatPreviewHost.mockReturnValue(null);
    mockResolveChatPreviewSessionForHost.mockResolvedValue(null);
    mockMatchesGatewayHost.mockResolvedValue(false);
    mockGetGatewayObject.mockReset();
    mockHttpRequest.mockReset();
    mockHttpsRequest.mockReset();
    mockLifecycleMode = 'web';
    mockStreamK8sLogs.mockReturnValue({ abort: jest.fn() });
    mockAgentSessionGetSession.mockResolvedValue(null);
    mockVerifyBearerToken.mockResolvedValue({ success: false });
    mockAgentSessionFindOne.mockResolvedValue(null);
    mockAgentSessionFindById.mockResolvedValue(null);
    mockAgentSandboxFindById.mockResolvedValue(null);
    mockResolveWorkspaceEditorEndpoint.mockResolvedValue(null);
    mockRestorePreviewExposures.mockResolvedValue(undefined);
    mockResolvePersistedPreviewEndpointWithAuth.mockResolvedValue(null);
    mockTryRegisterEditorConnection.mockReturnValue(true);
    mockClassifyEditorProxyFailure.mockReturnValue('unreachable');
    mockResolveEditorProxyFailureMapping.mockImplementation((reason: string) => ({
      message: reason === 'auth' ? 'Editor authentication failed' : 'Editor unavailable',
      reason,
      status: reason === 'auth' ? 401 : 502,
    }));
    mockBuildWorkspaceEditorErrorPage.mockReturnValue('<h1>Editor unavailable</h1>');
    mockIsEditorNavigationRequest.mockReturnValue(false);
    mockSerializeSocketHttpResponse.mockImplementation(({ statusCode }: { statusCode: number }) =>
      Buffer.from(`HTTP response ${statusCode}`)
    );
    mockParseCookieHeader.mockReturnValue({});
    mockVerifyChatPreviewGrant.mockReturnValue(false);
    mockBuildChatPreviewAuthRedirectUrl.mockReturnValue('https://lifecycle.test/preview/authorize');
    mockBuildChatPreviewCookie.mockImplementation((_req, grant: string) => `preview-cookie=${grant}; HttpOnly`);
    mockBuildProxyHeaders.mockReturnValue({ 'x-forwarded-by': 'lifecycle' });
    mockRewritePreviewResponseHeader.mockImplementation((_key, value: string) => `rewritten:${value}`);
    mockStripPreviewBootstrapParams.mockImplementation((rawUrl: string) => {
      const url = new URL(rawUrl, 'http://placeholder');
      url.searchParams.delete('grant');
      url.searchParams.delete('previewHost');
      url.searchParams.delete('token');
      return `${url.pathname}${url.search}`;
    });
    mockStripQueryParamsFromRequestUrl.mockImplementation((rawUrl: string, params: Iterable<string>) => {
      const url = new URL(rawUrl, 'http://placeholder');
      for (const param of params) url.searchParams.delete(param);
      return `${url.pathname}${url.search}`;
    });
    mockAppendForwardQuery.mockImplementation(
      (target: URL, query: Record<string, string | string[] | undefined>, blocked: Iterable<string> = []) => {
        const blockedNames = new Set(blocked);
        for (const [key, value] of Object.entries(query)) {
          if (value == null || blockedNames.has(key)) continue;
          for (const item of Array.isArray(value) ? value : [value]) target.searchParams.append(key, item);
        }
      }
    );
    mockBuildRemoteTargetUrl.mockImplementation(
      (
        endpoint: string,
        forwardPath: string,
        query: Record<string, string | string[] | undefined>,
        options: { blockedQueryParams?: Iterable<string>; isWebSocket?: boolean }
      ) => {
        const target = new URL(endpoint);
        if (options.isWebSocket) target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        target.pathname = `${target.pathname.replace(/\/+$/, '')}${
          forwardPath.startsWith('/') ? forwardPath : `/${forwardPath}`
        }`;
        mockAppendForwardQuery(target, query, options.blockedQueryParams);
        return target;
      }
    );
    const exposureQuery = {
      first: mockExposureFirst,
      orderBy: jest.fn(),
      where: jest.fn(),
      whereNull: jest.fn(),
      whereRaw: jest.fn(),
    };
    for (const method of ['orderBy', 'where', 'whereNull', 'whereRaw'] as const) {
      exposureQuery[method].mockReturnValue(exposureQuery);
    }
    mockExposureQuery.mockReturnValue(exposureQuery);
    delete process.env.ENABLE_AUTH;
  });

  afterAll(() => {
    setIntervalSpy.mockRestore();
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('starts on the configured port and delegates an ordinary request to Next with its parsed URL', async () => {
    const handler = await bootServer();
    const req = request('/health?verbose=true');
    const res = response();

    await handler(req, res);

    expect(mockHttpServer.listen).toHaveBeenCalledWith(3000);
    expect(mockMcpHttpRequestHandler).toHaveBeenCalledWith(req, res, '/health', mockRegistry);
    expect(mockNextHandler).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ pathname: '/health', query: { verbose: 'true' } })
    );
  });

  it('short-circuits Next when the MCP handler accepts the request', async () => {
    mockMcpHttpRequestHandler.mockResolvedValue(true);
    const handler = await bootServer();
    const req = request('/mcp');
    const res = response();

    await handler(req, res);

    expect(mockMcpHttpRequestHandler).toHaveBeenCalledWith(req, res, '/mcp', mockRegistry);
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('returns preview-not-found without falling through when a preview host has no active session', async () => {
    mockParseChatPreviewHost.mockReturnValue({ host: 'preview.example.test', port: 3001, previewSlug: 'app' });
    const handler = await bootServer();
    const res = response();

    await handler(request('/dashboard'), res);

    expect(mockResolveChatPreviewSessionForHost).toHaveBeenCalledWith({
      host: 'preview.example.test',
      port: 3001,
      previewSlug: 'app',
    });
    expect(res.statusCode).toBe(404);
    expect(res.setHeader).toHaveBeenCalledWith('X-Preview-Proxy-Reason', 'preview-not-found');
    expect(res.end).toHaveBeenCalledWith('Preview is unavailable');
    expect(mockMcpHttpRequestHandler).not.toHaveBeenCalled();
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('serves a gateway HEAD request without forwarding its body or falling through', async () => {
    mockLifecycleMode = 'gateway';
    mockMatchesGatewayHost.mockResolvedValue(true);
    const body = { destroy: jest.fn(), on: jest.fn(), pipe: jest.fn() };
    mockGetGatewayObject.mockResolvedValue({
      body,
      contentLength: 42,
      contentType: 'text/html; charset=utf-8',
      statusCode: 200,
    });
    const handler = await bootServer();
    const req = { ...request('/docs/index.html'), method: 'HEAD' };
    const res = response();

    await handler(req, res);

    expect(mockMatchesGatewayHost).toHaveBeenCalledWith('lifecycle.test');
    expect(mockGetGatewayObject).toHaveBeenCalledWith('lifecycle.test', '/docs/index.html');
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '42');
    expect(body.destroy).toHaveBeenCalledTimes(1);
    expect(body.pipe).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledWith();
    expect(mockMcpHttpRequestHandler).not.toHaveBeenCalled();
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('pipes a gateway GET response and converts a body-stream failure into 502', async () => {
    mockLifecycleMode = 'gateway';
    mockMatchesGatewayHost.mockResolvedValue(true);
    const bodyListeners: Record<string, Listener> = {};
    const body = {
      on: jest.fn((event: string, listener: Listener) => {
        bodyListeners[event] = listener;
      }),
      pipe: jest.fn(),
    };
    mockGetGatewayObject.mockResolvedValue({
      body,
      contentType: 'application/javascript',
      statusCode: 200,
    });
    const handler = await bootServer();
    const res = response();

    await handler(request('/assets/app.js'), res);

    expect(body.pipe).toHaveBeenCalledWith(res);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, max-age=60');
    expect(mockMcpHttpRequestHandler).not.toHaveBeenCalled();
    bodyListeners.error(new Error('object store disconnected'));
    expect(res.statusCode).toBe(502);
    expect(res.end).toHaveBeenCalledWith();
  });

  it.each([
    ['not-found storage failures', Object.assign(new Error('missing'), { statusCode: 404 }), 404, 'not found'],
    ['unexpected storage failures', new Error('object store unavailable'), 500, 'internal server error'],
  ])('maps %s without falling through to another handler', async (_label, error, status, body) => {
    mockLifecycleMode = 'gateway';
    mockMatchesGatewayHost.mockResolvedValue(true);
    mockGetGatewayObject.mockRejectedValue(error);
    const handler = await bootServer();
    const res = response();

    await handler(request('/missing.html'), res);

    expect(res.statusCode).toBe(status);
    expect(res.end).toHaveBeenCalledWith(body);
    expect(mockMcpHttpRequestHandler).not.toHaveBeenCalled();
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('exchanges an authenticated editor query token for a scoped cookie and a clean redirect', async () => {
    process.env.ENABLE_AUTH = 'true';
    mockAgentSessionGetSession.mockResolvedValue({
      id: 'db-session-1',
      namespace: 'agent-ns',
      podName: 'agent-pod',
      status: 'active',
      userId: 'user-1',
      workspaceStatus: 'ready',
    });
    mockVerifyBearerToken.mockResolvedValue({ payload: { sub: 'user-1' }, success: true });
    const handler = await bootServer();
    const res = response();

    await handler(request('/api/agent-session/workspace-editor/session-1/?token=bootstrap-token&theme=dark'), res);

    expect(mockVerifyBearerToken).toHaveBeenCalledWith('bootstrap-token');
    expect(res.statusCode).toBe(302);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('lfc_session_workspace_editor_auth=bootstrap-token')
    );
    expect(res.setHeader).toHaveBeenCalledWith('Location', '/api/agent-session/workspace-editor/session-1/?theme=dark');
    expect(mockTryRegisterEditorConnection).not.toHaveBeenCalled();
    expect(mockHttpRequest).not.toHaveBeenCalled();
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('authenticates and proxies an editor request while releasing its connection slot', async () => {
    process.env.ENABLE_AUTH = 'true';
    mockAgentSessionGetSession.mockResolvedValue({
      id: 'db-session-1',
      namespace: 'agent-ns',
      podName: 'agent-pod',
      status: 'active',
      userId: 'user-1',
      uuid: 'session-1',
      workspaceStatus: 'ready',
    });
    mockVerifyBearerToken.mockResolvedValue({ payload: { sub: 'user-1' }, success: true });
    const { proxyRequest } = mockUpstreamResponse({
      headers: {
        connection: 'close',
        'set-cookie': ['editor=ready; Path=/'],
        'x-editor': 'ready',
      },
      statusCode: 201,
    });
    const handler = await bootServer();
    const req = {
      ...request('/api/agent-session/workspace-editor/session-1/project?theme=dark'),
      headers: { authorization: 'Bearer editor-token', host: 'lifecycle.test' },
    };
    const res = response();

    await handler(req, res);

    expect(mockVerifyBearerToken).toHaveBeenCalledWith('editor-token');
    const target = mockHttpRequest.mock.calls[0][0] as URL;
    expect(target.toString()).toBe('http://agent-pod.agent-ns.svc.cluster.local:13337/project?theme=dark');
    expect(mockHttpRequest).toHaveBeenCalledWith(
      target,
      { headers: { 'x-forwarded-by': 'lifecycle' }, method: 'GET' },
      expect.any(Function)
    );
    expect(proxyRequest.end).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(201);
    expect(res.setHeader).toHaveBeenCalledWith('x-editor', 'ready');
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', 'editor=ready; Path=/');
    expect(res.setHeader).not.toHaveBeenCalledWith('connection', expect.anything());
    expect(mockReleaseEditorConnection).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('maps an editor upstream failure and releases the reserved connection slot', async () => {
    mockAgentSessionGetSession.mockResolvedValue({
      id: 'db-session-1',
      namespace: 'agent-ns',
      podName: 'agent-pod',
      status: 'active',
      uuid: 'session-1',
      workspaceStatus: 'ready',
    });
    mockUpstreamFailure(new Error('connect ECONNREFUSED'));
    const handler = await bootServer();
    const res = response();

    await handler(request('/api/agent-session/workspace-editor/session-1/project'), res);

    expect(mockClassifyEditorProxyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'connect ECONNREFUSED' }),
      {}
    );
    expect(res.statusCode).toBe(502);
    expect(res.setHeader).toHaveBeenCalledWith('X-Editor-Proxy-Reason', 'unreachable');
    expect(res.end).toHaveBeenCalledWith('Editor unavailable');
    expect(mockReleaseEditorConnection).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('rejects excess editor connections before contacting the workspace backend', async () => {
    mockAgentSessionGetSession.mockResolvedValue({
      id: 'db-session-1',
      namespace: 'agent-ns',
      podName: 'agent-pod',
      status: 'active',
      uuid: 'session-1',
      workspaceStatus: 'ready',
    });
    mockTryRegisterEditorConnection.mockReturnValue(false);
    mockClassifyEditorProxyFailure.mockReturnValueOnce('capacity');
    mockResolveEditorProxyFailureMapping.mockReturnValueOnce({
      message: 'This session has too many open editor connections. Close some tabs and try again.',
      reason: 'capacity',
      status: 503,
    });
    const handler = await bootServer();
    const res = response();

    await handler(request('/api/agent-session/workspace-editor/session-1/project'), res);

    expect(res.statusCode).toBe(503);
    expect(res.setHeader).toHaveBeenCalledWith('X-Editor-Proxy-Reason', 'capacity');
    expect(res.end).toHaveBeenCalledWith(
      'This session has too many open editor connections. Close some tabs and try again.'
    );
    expect(mockResolveWorkspaceEditorEndpoint).not.toHaveBeenCalled();
    expect(mockHttpRequest).not.toHaveBeenCalled();
    expect(mockReleaseEditorConnection).not.toHaveBeenCalled();
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('redirects an unauthorized preview request without resolving or contacting its backend', async () => {
    process.env.ENABLE_AUTH = 'true';
    configurePreviewHost();
    const handler = await bootServer();
    const res = response();

    await handler(request('/dashboard?grant=invalid'), res);

    expect(mockVerifyChatPreviewGrant).toHaveBeenLastCalledWith(
      'invalid',
      expect.objectContaining({ previewHost: 'preview.example.test', sessionId: 'preview-session', userId: 'user-1' })
    );
    expect(res.statusCode).toBe(302);
    expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
    expect(res.setHeader).toHaveBeenCalledWith('Location', 'https://lifecycle.test/preview/authorize');
    expect(mockResolvePersistedPreviewEndpointWithAuth).not.toHaveBeenCalled();
    expect(mockHttpRequest).not.toHaveBeenCalled();
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('exchanges a valid preview grant for a cookie and removes it from the redirect URL', async () => {
    process.env.ENABLE_AUTH = 'true';
    configurePreviewHost();
    mockVerifyChatPreviewGrant.mockImplementation((grant: string | undefined) => grant === 'valid-grant');
    const handler = await bootServer();
    const res = response();

    await handler(request('/dashboard?grant=valid-grant&view=full'), res);

    expect(res.statusCode).toBe(302);
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', 'preview-cookie=valid-grant; HttpOnly');
    expect(res.setHeader).toHaveBeenCalledWith('Location', '/dashboard?view=full');
    expect(mockResolvePersistedPreviewEndpointWithAuth).not.toHaveBeenCalled();
    expect(mockHttpRequest).not.toHaveBeenCalled();
  });

  it('proxies an authorized preview response while dropping upstream credentials', async () => {
    configurePreviewHost();
    const { proxyRequest } = mockUpstreamResponse({
      headers: {
        connection: 'close',
        location: '/sign-in',
        'set-cookie': ['untrusted=1'],
      },
      statusCode: 202,
    });
    const handler = await bootServer();
    const req = request('/dashboard?view=full');
    const res = response();

    await handler(req, res);

    const target = mockHttpRequest.mock.calls[0][0] as URL;
    expect(target.toString()).toBe('http://workspace.gateway/base/dashboard?view=full');
    expect(mockBuildProxyHeaders).toHaveBeenCalledWith(req, target, '', { 'x-workspace-token': 'secret' }, false, true);
    expect(proxyRequest.end).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(202);
    expect(res.setHeader).toHaveBeenCalledWith('location', 'rewritten:/sign-in');
    expect(res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything());
    expect(res.setHeader).not.toHaveBeenCalledWith('connection', expect.anything());
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('returns a stable preview-unavailable response when the preview transport fails', async () => {
    configurePreviewHost();
    mockUpstreamFailure(new Error('gateway refused connection'));
    const handler = await bootServer();
    const res = response();

    await handler(request('/dashboard'), res);

    expect(res.statusCode).toBe(502);
    expect(res.setHeader).toHaveBeenCalledWith('X-Preview-Proxy-Reason', 'preview-unavailable');
    expect(res.end).toHaveBeenCalledWith('Preview is unavailable');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'gateway refused connection' }),
        path: '/dashboard',
        port: 3001,
        sessionId: 'preview-session',
      }),
      'ChatPreview: proxy failed'
    );
    expect(mockNextHandler).not.toHaveBeenCalled();
  });

  it('returns a stable 500 response when downstream HTTP dispatch rejects', async () => {
    mockNextHandler.mockRejectedValue(new Error('next failed'));
    const handler = await bootServer();
    const res = response();

    await handler(request('/broken'), res);

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('internal server error');
    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'next failed' }) },
      'Error handling HTTP request'
    );
  });

  it('proxies an authenticated editor WebSocket upgrade and releases the slot when the client closes', async () => {
    process.env.ENABLE_AUTH = 'true';
    mockAgentSessionGetSession.mockResolvedValue({
      id: 'db-session-1',
      namespace: 'agent-ns',
      podName: 'agent-pod',
      status: 'active',
      userId: 'user-1',
      uuid: 'session-1',
      workspaceStatus: 'ready',
    });
    mockVerifyBearerToken.mockResolvedValue({ payload: { sub: 'user-1' }, success: true });
    const { listeners, proxyRequest } = mockUpgradeRequest();
    await bootServer();
    const clientSocket = rawSocket();
    const upstreamSocket = rawSocket();
    const req = {
      ...request('/api/agent-session/workspace-editor/session-1/socket?theme=dark'),
      headers: { authorization: 'Bearer editor-token', host: 'lifecycle.test' },
    };
    const clientHead = Buffer.from('client-head');
    const upstreamHead = Buffer.from('upstream-head');

    mockServerListeners.upgrade(req, clientSocket, clientHead);
    await waitFor(() => mockHttpRequest.mock.calls.length === 1, 'editor upgrade did not contact its backend');

    const upstreamUrl = mockHttpRequest.mock.calls[0][0] as URL;
    expect(upstreamUrl.toString()).toBe('http://agent-pod.agent-ns.svc.cluster.local:13337/socket?theme=dark');
    expect(mockBuildProxyHeaders.mock.calls.at(-1)?.[4]).toBe(true);
    listeners.upgrade(
      {
        headers: { 'set-cookie': ['editor=ready'], upgrade: 'websocket' },
        statusCode: 101,
        statusMessage: 'Switching',
      },
      upstreamSocket,
      upstreamHead
    );
    await waitFor(() => clientSocket.pipe.mock.calls.length === 1, 'editor WebSocket pipe was not established');

    expect(proxyRequest.end).toHaveBeenCalledTimes(1);
    expect(mockSerializeSocketHttpResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'set-cookie': ['editor=ready'], upgrade: 'websocket' },
        statusCode: 101,
      })
    );
    expect(clientSocket.write).toHaveBeenCalledWith(upstreamHead);
    expect(upstreamSocket.write).toHaveBeenCalledWith(clientHead);
    expect(clientSocket.pipe).toHaveBeenCalledWith(upstreamSocket);
    expect(upstreamSocket.pipe).toHaveBeenCalledWith(clientSocket);
    expect(mockReleaseEditorConnection).not.toHaveBeenCalled();

    clientSocket.emit('close');
    expect(mockReleaseEditorConnection).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(upstreamSocket.end).toHaveBeenCalledTimes(1);
  });

  it('drops a malformed encoded editor session id before resolving a session or backend', async () => {
    await bootServer();
    const clientSocket = rawSocket();

    mockServerListeners.upgrade(
      request('/api/agent-session/workspace-editor/%E0%A4%A/socket'),
      clientSocket,
      Buffer.alloc(0)
    );

    expect(clientSocket.destroy).toHaveBeenCalledTimes(1);
    expect(clientSocket.end).not.toHaveBeenCalled();
    expect(mockSerializeSocketHttpResponse).not.toHaveBeenCalled();
    expect(mockAgentSessionGetSession).not.toHaveBeenCalled();
    expect(mockHttpRequest).not.toHaveBeenCalled();
  });

  it('denies an unauthorized chat-preview WebSocket upgrade before contacting its backend', async () => {
    process.env.ENABLE_AUTH = 'true';
    configurePreviewHost();
    await bootServer();
    const clientSocket = rawSocket();

    mockServerListeners.upgrade(request('/socket'), clientSocket, Buffer.alloc(0));
    await waitFor(() => clientSocket.end.mock.calls.length === 1, 'preview upgrade was not rejected');

    expect(mockSerializeSocketHttpResponse).toHaveBeenCalledWith({
      body: 'Unauthorized',
      statusCode: 401,
      statusMessage: 'Unauthorized',
    });
    expect(mockHttpRequest).not.toHaveBeenCalled();
    expect(mockTryRegisterEditorConnection).not.toHaveBeenCalled();
  });

  it('returns preview-unavailable when an authorized preview has no live backend target', async () => {
    configurePreviewHost();
    mockResolvePersistedPreviewEndpointWithAuth.mockResolvedValue(null);
    await bootServer();
    const clientSocket = rawSocket();

    mockServerListeners.upgrade(request('/socket'), clientSocket, Buffer.alloc(0));
    await waitFor(() => clientSocket.end.mock.calls.length === 1, 'missing preview target was not rejected');

    expect(mockSerializeSocketHttpResponse).toHaveBeenCalledWith({
      body: 'Preview is unavailable',
      headers: { 'X-Preview-Proxy-Reason': 'preview-unavailable' },
      statusCode: 502,
      statusMessage: 'Bad Gateway',
    });
    expect(mockHttpRequest).not.toHaveBeenCalled();
    expect(mockTryRegisterEditorConnection).not.toHaveBeenCalled();
    expect(mockReleaseEditorConnection).not.toHaveBeenCalled();
  });

  it('proxies an authorized chat-preview WebSocket upgrade and strips upstream cookies', async () => {
    configurePreviewHost();
    const { listeners, proxyRequest } = mockUpgradeRequest();
    await bootServer();
    const clientSocket = rawSocket();
    const upstreamSocket = rawSocket();
    const req = request('/socket?view=full');
    const clientHead = Buffer.from('client-head');
    const upstreamHead = Buffer.from('upstream-head');

    mockServerListeners.upgrade(req, clientSocket, clientHead);
    await waitFor(() => mockHttpRequest.mock.calls.length === 1, 'preview upgrade did not contact its backend');

    const upstreamUrl = mockHttpRequest.mock.calls[0][0] as URL;
    expect(upstreamUrl.toString()).toBe('http://workspace.gateway/base/socket?view=full');
    const previewTarget = mockBuildProxyHeaders.mock.calls.at(-1)?.[1] as URL;
    expect(previewTarget.toString()).toBe('ws://workspace.gateway/base/socket?view=full');
    expect(mockBuildProxyHeaders.mock.calls.at(-1)?.slice(2)).toEqual([
      '',
      { 'x-workspace-token': 'secret' },
      true,
      true,
    ]);
    listeners.upgrade(
      { headers: { 'set-cookie': ['untrusted=1'], upgrade: 'websocket' }, statusCode: 101 },
      upstreamSocket,
      upstreamHead
    );
    await waitFor(() => clientSocket.pipe.mock.calls.length === 1, 'preview WebSocket pipe was not established');

    expect(proxyRequest.end).toHaveBeenCalledTimes(1);
    expect(mockSerializeSocketHttpResponse).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { upgrade: 'websocket' }, statusCode: 101 })
    );
    expect(clientSocket.write).toHaveBeenCalledWith(upstreamHead);
    expect(upstreamSocket.write).toHaveBeenCalledWith(clientHead);
    expect(clientSocket.pipe).toHaveBeenCalledWith(upstreamSocket);
    expect(upstreamSocket.pipe).toHaveBeenCalledWith(clientSocket);
    expect(mockReleaseEditorConnection).not.toHaveBeenCalled();

    clientSocket.emit('close');
    expect(mockReleaseEditorConnection).toHaveBeenCalledWith('preview:preview-session', expect.any(Object));
    expect(upstreamSocket.end).toHaveBeenCalledTimes(1);
  });

  it('accepts only the log-stream WebSocket path and destroys an unknown upgrade', async () => {
    await bootServer();
    const upgrade = mockServerListeners.upgrade;
    const acceptedSocket = { destroy: jest.fn() };
    const rejectedSocket = { destroy: jest.fn() };
    const req = request('/api/logs/stream');
    const upgradedWs = webSocket();
    mockWss.handleUpgrade.mockImplementationOnce((_request, _socket, _head, callback: Listener) => {
      callback(upgradedWs);
    });

    upgrade(req, acceptedSocket, Buffer.from('head'));
    upgrade(request('/unknown'), rejectedSocket, Buffer.alloc(0));

    expect(mockWss.handleUpgrade).toHaveBeenCalledWith(req, acceptedSocket, expect.any(Buffer), expect.any(Function));
    expect(mockWss.emit).toHaveBeenCalledWith('connection', upgradedWs, req);
    expect(acceptedSocket.destroy).not.toHaveBeenCalled();
    expect(rejectedSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects a log-stream connection with missing required query parameters before opening Kubernetes', async () => {
    await bootServer();
    const ws = webSocket();

    mockWssListeners.connection(ws, request('/api/logs/stream?podName=api'));

    expect(mockStreamK8sLogs).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Connection error: Missing or invalid required parameters: podName, namespace, containerName',
      })
    );
    expect(ws.close).toHaveBeenCalledWith(
      1008,
      'Connection error: Missing or invalid required parameters: podName, namespace, containerName'
    );
  });

  it('rejects a nonnumeric tailLines value before opening Kubernetes', async () => {
    await bootServer();
    const ws = webSocket();

    mockWssListeners.connection(
      ws,
      request('/api/logs/stream?podName=api-0&namespace=preview&containerName=api&tailLines=lots')
    );

    expect(mockStreamK8sLogs).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Connection error: Invalid tailLines parameter.' })
    );
    expect(ws.close).toHaveBeenCalledWith(1008, 'Connection error: Invalid tailLines parameter.');
  });

  it('streams parsed Kubernetes log options, forwards data, and aborts when the client closes', async () => {
    await bootServer();
    const abort = jest.fn();
    mockStreamK8sLogs.mockReturnValue({ abort });
    const ws = webSocket();

    mockWssListeners.connection(
      ws,
      request(
        '/api/logs/stream?podName=api-0&namespace=preview&containerName=api&follow=true&tailLines=25&timestamps=true'
      )
    );

    expect(mockStreamK8sLogs).toHaveBeenCalledWith(
      {
        containerName: 'api',
        follow: true,
        namespace: 'preview',
        podName: 'api-0',
        tailLines: 25,
        timestamps: true,
      },
      expect.objectContaining({
        onData: expect.any(Function),
        onEnd: expect.any(Function),
        onError: expect.any(Function),
      })
    );
    const callbacks = mockStreamK8sLogs.mock.calls[0][1];
    callbacks.onData('ready');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'log', payload: 'ready' }));

    ws.listeners.close(1000, Buffer.from('client done'));
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('reports Kubernetes stream failure to the client and closes with an internal-error code', async () => {
    await bootServer();
    const ws = webSocket();
    mockWssListeners.connection(ws, request('/api/logs/stream?podName=api-0&namespace=preview&containerName=api'));
    const callbacks = mockStreamK8sLogs.mock.calls[0][1];

    callbacks.onError(new Error('pod disappeared'));

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Kubernetes stream error: pod disappeared' })
    );
    expect(ws.close).toHaveBeenCalledWith(1011, 'Kubernetes stream error');
  });

  it('signals a clean end when Kubernetes reports that the container terminated', async () => {
    await bootServer();
    const ws = webSocket();
    mockWssListeners.connection(ws, request('/api/logs/stream?podName=api-0&namespace=preview&containerName=api'));
    const callbacks = mockStreamK8sLogs.mock.calls[0][1];

    callbacks.onEnd();

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'end', reason: 'ContainerTerminated' }));
    expect(ws.close).toHaveBeenCalledWith(1000, 'Stream ended');
  });

  it('aborts the Kubernetes stream and closes an open socket after a WebSocket error', async () => {
    await bootServer();
    const abort = jest.fn();
    mockStreamK8sLogs.mockReturnValue({ abort });
    const ws = webSocket();
    mockWssListeners.connection(ws, request('/api/logs/stream?podName=api-0&namespace=preview&containerName=api'));

    ws.listeners.error(new Error('transport failed'));

    expect(abort).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(1011, 'WebSocket error');
  });
});
