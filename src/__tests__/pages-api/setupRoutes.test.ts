import { request, response } from 'src/test-utils/pagesApi';

const mockGetConfig = jest.fn();
const mockSetConfig = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockUpdateSecret = jest.fn();
const mockGetNamespace = jest.fn();
const mockShellPromise = jest.fn();
const mockRandomBytes = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
let mockAppHost = 'https://lifecycle.example.test';

jest.mock('server/services/globalConfig', () => {
  const instance = {
    getConfig: (...args: unknown[]) => mockGetConfig(...args),
    setConfig: (...args: unknown[]) => mockSetConfig(...args),
    getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
  };
  const Service = jest.fn(() => instance) as jest.Mock & { getInstance: jest.Mock };
  Service.getInstance = jest.fn(() => instance);
  return { __esModule: true, default: Service };
});

jest.mock('server/lib/kubernetes', () => ({
  updateSecret: (...args: unknown[]) => mockUpdateSecret(...args),
  getCurrentNamespaceFromFile: (...args: unknown[]) => mockGetNamespace(...args),
}));

jest.mock('server/lib/shell', () => ({
  shellPromise: (...args: unknown[]) => mockShellPromise(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => mockLogger,
}));

jest.mock('crypto', () => ({
  randomBytes: (...args: unknown[]) => mockRandomBytes(...args),
}));

jest.mock('shared/config', () => ({
  get APP_HOST() {
    return mockAppHost;
  },
  GITHUB_APP_AUTH_CALLBACK: 'https://auth.example.test/callback',
  SECRET_BOOTSTRAP_NAME: 'lifecycle-bootstrap',
}));

import callbackHandler from 'src/pages/api/v1/setup/callback';
import configureHandler from 'src/pages/api/v1/setup/configure';
import setupHandler from 'src/pages/api/v1/setup';
import installedHandler from 'src/pages/api/v1/setup/installed';
import statusHandler from 'src/pages/api/v1/setup/status';

describe('legacy setup API routes', () => {
  const originalReleaseName = process.env.HELM_RELEASE_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAppHost = 'https://lifecycle.example.test';
    mockGetNamespace.mockReturnValue('lifecycle-system');
    mockRandomBytes.mockReturnValue({ toString: jest.fn(() => 'fixed-state') });
    mockGetConfig.mockImplementation(async (key: string) => {
      if (key === 'app_setup') return { state: 'fixed-state', installed: false };
      if (key === 'lifecycleDefaults') return { existing: 'lifecycle' };
      if (key === 'domainDefaults') return { existing: 'domain' };
      return undefined;
    });
    process.env.HELM_RELEASE_NAME = 'lifecycle';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        id: 'app-1',
        client_id: 'client-1',
        client_secret: 'client-secret',
        webhook_secret: 'webhook-secret',
        pem: 'line1\nline2',
        html_url: 'https://github.com/apps/lifecycle-test',
        slug: 'lifecycle-test',
      }),
    }) as typeof fetch;
  });

  afterAll(() => {
    if (originalReleaseName === undefined) delete process.env.HELM_RELEASE_NAME;
    else process.env.HELM_RELEASE_NAME = originalReleaseName;
  });

  describe('GET /setup', () => {
    it('rejects unsupported methods and installed applications before generating state', async () => {
      const methodRes = response();
      await setupHandler(request({ method: 'POST' }), methodRes);
      expect(methodRes.statusCode).toBe(405);
      expect(mockGetConfig).not.toHaveBeenCalled();

      mockGetConfig.mockResolvedValueOnce({ installed: true });
      const installedRes = response();
      await setupHandler(request(), installedRes);
      expect(installedRes.redirect).toHaveBeenCalledWith('/setup');
      expect(mockRandomBytes).not.toHaveBeenCalled();
    });

    it.each([
      [{}, 'App name is not valid.'],
      [{ app_name: 'x'.repeat(35) }, 'App name is not valid.'],
      [{ app_name: 'valid-app', org: 'bad org' }, 'Organization name is not valid.'],
      [{ app_name: 'valid-app', org: 'x'.repeat(40) }, 'Organization name is not valid.'],
    ])('validates manifest identity fields: %j', async (query, error) => {
      const res = response();
      await setupHandler(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error });
      expect(mockSetConfig).not.toHaveBeenCalled();
    });

    it('validates input when app setup state has not been created yet', async () => {
      mockGetConfig.mockResolvedValueOnce(undefined);
      const res = response();
      await setupHandler(request({ query: {} }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'App name is not valid.' });
    });

    it.each(['', 'not a url'])('rejects an invalid configured public URL: %j', async (appHost) => {
      mockAppHost = appHost;
      const res = response();
      await setupHandler(request({ query: { app_name: 'valid-app' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Application public URL is not valid.' });
    });

    it.each([
      [{ app_name: ' lifecycle-app ' }, 'https://github.com/settings/apps/new?state=fixed-state'],
      [
        { app_name: 'lifecycle-app', org: ' goodrx ' },
        'https://github.com/organizations/goodrx/settings/apps/new?state=fixed-state',
      ],
    ])('persists state and renders the GitHub manifest form', async (query, actionUrl) => {
      const res = response();
      await setupHandler(request({ query }), res);

      expect(mockSetConfig).toHaveBeenCalledWith('app_setup', {
        state: 'fixed-state',
        created: false,
        installed: false,
        org: 'org' in query ? 'goodrx' : '',
        appUrl: 'https://lifecycle.example.test',
      });
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining(`action="${actionUrl}"`));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('"workflows":"write"'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('https://auth.example.test/callback'));
    });
  });

  describe('GET /setup/callback', () => {
    it.each([
      [{ state: 'fixed-state' }, { error: 'Missing authorization code' }],
      [{ code: 'code-1' }, { error: 'Missing state parameter' }],
    ])('requires OAuth callback parameters: %j', async (query, body) => {
      const res = response();
      await callbackHandler(request({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(body);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects a mismatched state and an already-installed app', async () => {
      mockGetConfig.mockResolvedValueOnce({ state: 'other-state' });
      const stateRes = response();
      await callbackHandler(request({ query: { code: 'code-1', state: 'fixed-state' } }), stateRes);
      expect(stateRes.body).toEqual({ error: 'Invalid state parameter' });

      mockGetConfig
        .mockResolvedValueOnce({ state: 'fixed-state' })
        .mockResolvedValueOnce({ state: 'fixed-state', installed: true });
      const installedRes = response();
      await callbackHandler(request({ query: { code: 'code-1', state: 'fixed-state' } }), installedRes);
      expect(installedRes.body).toEqual({ error: 'App already installed' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('maps GitHub conversion failure and invalid credentials without mutating secrets', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: jest.fn().mockResolvedValue({ message: 'expired' }),
      });
      const githubRes = response();
      await callbackHandler(request({ query: { code: 'expired', state: 'fixed-state' } }), githubRes);
      expect(githubRes.statusCode).toBe(422);
      expect(githubRes.body).toEqual({ error: 'Failed to convert manifest code' });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ id: 'incomplete' }),
      });
      const invalidRes = response();
      await callbackHandler(request({ query: { code: 'code-1', state: 'fixed-state' } }), invalidRes);
      expect(invalidRes.statusCode).toBe(400);
      expect(invalidRes.body).toEqual({ error: 'Invalid response from GitHub' });
      expect(mockUpdateSecret).not.toHaveBeenCalled();
    });

    it('stores converted credentials and redirects to GitHub installation', async () => {
      const res = response();
      await callbackHandler(request({ query: { code: 'code-1', state: 'fixed-state' } }), res);

      expect(global.fetch).toHaveBeenCalledWith('https://api.github.com/app-manifests/code-1/conversions', {
        method: 'POST',
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      expect(mockUpdateSecret).toHaveBeenCalledWith(
        'lifecycle-bootstrap',
        {
          GITHUB_APP_ID: 'app-1',
          GITHUB_CLIENT_ID: 'client-1',
          GITHUB_CLIENT_SECRET: 'client-secret',
          GITHUB_WEBHOOK_SECRET: 'webhook-secret',
          GITHUB_PRIVATE_KEY: 'line1\\nline2',
        },
        'lifecycle-system'
      );
      expect(mockSetConfig).toHaveBeenCalledWith('app_setup', {
        state: 'fixed-state',
        installed: false,
        created: true,
        url: 'https://github.com/apps/lifecycle-test',
        name: 'lifecycle-test',
      });
      expect(res.redirect).toHaveBeenCalledWith('https://github.com/apps/lifecycle-test/installations/new');
    });

    it('returns the stable setup error on unexpected failures', async () => {
      mockGetConfig.mockRejectedValueOnce(new Error('database unavailable'));
      const res = response();
      await callbackHandler(request({ query: { code: 'code-1', state: 'fixed-state' } }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'An error occurred during GitHub app setup' });
    });
  });

  describe('GET /setup/installed', () => {
    it.each([
      [{}, 400, { error: 'Missing installation_id' }],
      [{ installation_id: 'install-1', setup_action: 'update' }, 500, { error: 'Invalid setup_action' }],
    ])('validates installation callback query: %j', async (query, status, body) => {
      const res = response();
      await installedHandler(request({ query }), res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual(body);
      expect(mockSetConfig).not.toHaveBeenCalled();
    });

    it.each([
      [undefined, 404, { error: 'No app_setup found.' }],
      [{ installed: true }, 400, { error: 'App already installed.' }],
    ])('rejects unusable app_setup state', async (appSetup, status, body) => {
      mockGetConfig.mockResolvedValueOnce(appSetup);
      const res = response();
      await installedHandler(request({ query: { installation_id: 'install-1' } }), res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual(body);
      expect(mockUpdateSecret).not.toHaveBeenCalled();
    });

    it('records installation, updates the bootstrap secret, and redirects with state', async () => {
      const res = response();
      await installedHandler(request({ query: { installation_id: 'install-1', setup_action: 'install' } }), res);

      const installedState = { state: 'fixed-state', installed: true };
      expect(mockSetConfig).toHaveBeenCalledWith('app_setup', installedState);
      expect(mockUpdateSecret).toHaveBeenCalledWith(
        'lifecycle-bootstrap',
        { GITHUB_APP_INSTALLATION_ID: 'install-1' },
        'lifecycle-system'
      );
      expect(res.redirect).toHaveBeenCalledWith(
        `/setup/complete?app_setup=${encodeURIComponent(JSON.stringify(installedState))}`
      );
    });
  });

  describe('POST /setup/configure', () => {
    it('fails before reading config when namespace or release name is missing', async () => {
      mockGetNamespace.mockReturnValueOnce('');
      const noNamespace = response();
      await configureHandler(request({ method: 'POST' }), noNamespace);
      expect(noNamespace.statusCode).toBe(500);

      mockGetNamespace.mockReturnValueOnce('lifecycle-system');
      delete process.env.HELM_RELEASE_NAME;
      const noRelease = response();
      await configureHandler(request({ method: 'POST' }), noRelease);
      expect(noRelease.statusCode).toBe(500);
      expect(mockGetConfig).not.toHaveBeenCalled();
    });

    it('does not request a second restart', async () => {
      process.env.HELM_RELEASE_NAME = 'lifecycle';
      mockGetConfig.mockResolvedValueOnce({ restarted: true });
      const res = response();
      await configureHandler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(400);
      expect(mockShellPromise).not.toHaveBeenCalled();
    });

    it('persists domain defaults, refreshes config, restarts, and marks setup', async () => {
      process.env.HELM_RELEASE_NAME = 'lifecycle';
      const res = response();
      await configureHandler(request({ method: 'POST' }), res);

      expect(mockSetConfig).toHaveBeenNthCalledWith(1, 'lifecycleDefaults', {
        existing: 'lifecycle',
        ecrDomain: 'distribution.example.test',
        defaultPublicUrl: 'dev-0.example.test',
      });
      expect(mockSetConfig).toHaveBeenNthCalledWith(2, 'domainDefaults', {
        existing: 'domain',
        http: 'example.test',
        grpc: 'example.test',
        publicScheme: 'https',
      });
      expect(mockGetAllConfigs).toHaveBeenCalledWith(true);
      expect(mockShellPromise).toHaveBeenCalledWith(
        'kubectl rollout restart deployment -l app.kubernetes.io/instance=lifecycle,app.kubernetes.io/name=lifecycle -n lifecycle-system'
      );
      expect(mockSetConfig).toHaveBeenNthCalledWith(3, 'app_setup', {
        state: 'fixed-state',
        installed: false,
        restarted: true,
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns a stable error when configuration or restart fails', async () => {
      process.env.HELM_RELEASE_NAME = 'lifecycle';
      mockShellPromise.mockRejectedValueOnce(new Error('rollout failed'));
      const res = response();
      await configureHandler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Restarting deployment failed' });
    });

    it('can configure when app_setup has not been initialized', async () => {
      process.env.HELM_RELEASE_NAME = 'lifecycle';
      mockGetConfig
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ existing: 'lifecycle' })
        .mockResolvedValueOnce({ existing: 'domain' });
      const res = response();
      await configureHandler(request({ method: 'POST' }), res);
      expect(res.statusCode).toBe(200);
      expect(mockSetConfig).toHaveBeenLastCalledWith('app_setup', { restarted: true });
    });
  });

  describe('GET /setup/status', () => {
    it('enforces GET and returns defaults for absent setup state', async () => {
      const methodRes = response();
      await statusHandler(request({ method: 'POST' }), methodRes);
      expect(methodRes.statusCode).toBe(405);

      mockGetConfig.mockResolvedValueOnce(undefined);
      const emptyRes = response();
      await statusHandler(request(), emptyRes);
      expect(emptyRes.body).toEqual({ installed: false, created: false, restarted: false, url: '' });
    });

    it('returns persisted setup status fields', async () => {
      mockGetConfig.mockResolvedValueOnce({ installed: true, created: true, restarted: true, url: 'app-url' });
      const res = response();
      await statusHandler(request(), res);
      expect(res.body).toEqual({ installed: true, created: true, restarted: true, url: 'app-url' });
    });
  });
});
