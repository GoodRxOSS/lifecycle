import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

let mockSetupToken = 'operator-token';
let mockEnvCredentials: Record<string, string> = {};
let mockRecords: Record<string, any> = {};
let mockSecret: any;
let mockCommitFailure = false;
let mockTransactionQueue = Promise.resolve();
const mockLock = jest.fn();
const mockInvalidate = jest.fn();
const mockExec = jest.fn();
const mockReadSecret = jest.fn();
const mockWriteSecret = jest.fn();
const mockAppAuth = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function mockTrx(_table: string) {
  let key = '';
  return {
    insert(value: { key: string; config: unknown }) {
      return {
        onConflict: () => ({
          ignore: async () => {
            mockRecords[value.key] ??= structuredClone(value.config);
          },
        }),
      };
    },
    where(value: { key: string }) {
      key = value.key;
      return this;
    },
    forUpdate() {
      mockLock(key);
      return this;
    },
    async first() {
      return { config: structuredClone(mockRecords[key]) };
    },
    async update(value: { config: unknown }) {
      mockRecords[key] = structuredClone(value.config);
    },
  };
}
mockTrx.raw = jest.fn().mockResolvedValue(undefined);
const mockTransaction = jest.fn((action) => {
  const result = mockTransactionQueue.then(async () => {
    const snapshot = structuredClone(mockRecords);
    try {
      const value = await action(mockTrx);
      if (mockCommitFailure) {
        mockCommitFailure = false;
        throw new Error('simulated commit failure');
      }
      return value;
    } catch (error) {
      mockRecords = snapshot;
      throw error;
    }
  });
  mockTransactionQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
});

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      db: { knex: { transaction: mockTransaction } },
      getConfig: async (key: string) => mockRecords[key],
      invalidateCache: (...args: unknown[]) => mockInvalidate(...args),
    }),
  },
}));
jest.mock('server/lib/kubernetes', () => ({
  getCurrentNamespaceFromFile: () => 'lifecycle',
  getK8sApi: () => ({
    addInterceptor: jest.fn(),
    readNamespacedSecret: mockReadSecret,
    replaceNamespacedSecret: mockWriteSecret,
    createNamespacedSecret: mockWriteSecret,
  }),
}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: () => mockAppAuth }));
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => mockExec(...args) }));
jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));
jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/services/apiToken', () => ({ scopeSatisfies: () => true }));
jest.mock('server/services/authRateLimit', () => ({ checkApiKeyRateLimit: async () => ({ allowed: true }) }));
jest.mock('server/services/authAudit', () => ({ recordAuthAuditEvent: jest.fn() }));
jest.mock('server/lib/principal', () => ({ resolvePrincipal: jest.fn() }));
jest.mock('shared/config', () => ({
  APP_HOST: 'https://lifecycle.example.test',
  GITHUB_APP_AUTH_CALLBACK: 'https://auth.example.test/callback',
  SECRET_BOOTSTRAP_NAME: 'bootstrap',
  get LIFECYCLE_SETUP_TOKEN() {
    return mockSetupToken;
  },
  get GITHUB_APP_ID() {
    return mockEnvCredentials.GITHUB_APP_ID ?? 'YOUR_VALUE_HERE';
  },
  get GITHUB_CLIENT_ID() {
    return mockEnvCredentials.GITHUB_CLIENT_ID ?? 'YOUR_VALUE_HERE';
  },
  get GITHUB_CLIENT_SECRET() {
    return mockEnvCredentials.GITHUB_CLIENT_SECRET ?? 'YOUR_VALUE_HERE';
  },
  get GITHUB_PRIVATE_KEY() {
    return mockEnvCredentials.GITHUB_PRIVATE_KEY ?? 'YOUR_VALUE_HERE';
  },
  get GITHUB_WEBHOOK_SECRET() {
    return mockEnvCredentials.GITHUB_WEBHOOK_SECRET ?? 'YOUR_VALUE_HERE';
  },
}));

import { POST as manifest } from '../manifest/route';
import { GET as callback } from '../callback/route';
import { GET as installed } from '../installed/route';
import { POST as configure } from '../configure/route';
import { GET as status } from '../status/route';
import { getSetupToken } from '../setupAccess';

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
function req(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  return new NextRequest(`https://lifecycle.example.test/api/setup/${path}`, {
    method: options.method || 'GET',
    headers: options.token === undefined ? {} : { 'x-setup-token': options.token },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
const post = (path: string, body?: unknown) => req(path, { method: 'POST', token: 'operator-token', body });
const decodeSecret = (key: string) => Buffer.from(mockSecret.data[key], 'base64').toString('utf8');

beforeEach(() => {
  jest.clearAllMocks();
  mockSetupToken = 'operator-token';
  mockEnvCredentials = {};
  mockCommitFailure = false;
  mockTransactionQueue = Promise.resolve();
  mockRecords = {
    app_setup: { created: false, installed: false, restarted: false, state: '', retained: 'setting' },
    lifecycleDefaults: {
      ecrDomain: 'distribution.example.com',
      defaultPublicUrl: 'dev-0.127.0.0.1.nip.io',
      extra: true,
    },
    domainDefaults: { http: '127.0.0.1.nip.io', grpc: '127.0.0.1.nip.io' },
  };
  mockSecret = {
    metadata: { name: 'bootstrap', resourceVersion: '1', annotations: { existing: 'annotation' } },
    data: { OTHER_KEY: Buffer.from('preserved').toString('base64') },
  };
  mockReadSecret.mockReset().mockImplementation(async () => ({ body: structuredClone(mockSecret) }));
  mockWriteSecret.mockReset().mockImplementation(async (_name, _namespace, body) => {
    const next = body || _namespace;
    if (next.metadata.resourceVersion && next.metadata.resourceVersion !== mockSecret.metadata.resourceVersion)
      throw new Error('resourceVersion conflict');
    mockSecret = structuredClone(next);
    mockSecret.metadata.resourceVersion = String(Number(mockSecret.metadata.resourceVersion || 0) + 1);
  });
  mockInvalidate.mockResolvedValue(undefined);
  mockExec.mockReset().mockImplementation((_file, _args, _options, done) => done(null, '', ''));
  mockAppAuth.mockResolvedValue({ token: 'app-jwt' });
  process.env.HELM_RELEASE_NAME = 'lifecycle';
  delete process.env.ENCRYPTION_KEY;
  global.fetch = jest.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('/conversions')
        ? {
            id: 123,
            client_id: 'client',
            client_secret: 'client-secret',
            webhook_secret: 'webhook-secret',
            pem: 'private-key',
            html_url: 'https://github.com/apps/fresh-app',
            slug: 'fresh-app',
          }
        : { app_id: 123 },
  })) as any;
});
afterAll(() => {
  process.env = originalEnv;
  global.fetch = originalFetch;
});

async function start() {
  const response = await manifest(post('manifest', { appName: 'fresh-app', org: 'example' }));
  expect(response.status).toBe(200);
  return mockRecords.app_setup.state;
}
async function create() {
  const state = await start();
  const response = await callback(req(`callback?code=code&state=${state}`));
  expect(response.status).toBe(307);
  return mockRecords.app_setup.state;
}
async function install() {
  const state = await create();
  const response = await installed(req(`installed?installation_id=456&setup_action=install&state=${state}`));
  expect(response.status).toBe(307);
}

it('requires the operator token before reading settings or mutating setup', async () => {
  for (const token of [undefined, 'wrong-token']) {
    const response = await manifest(req('manifest', { method: 'POST', token, body: { appName: 'fresh-app' } }));
    expect(response.status).toBe(401);
  }
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(mockReadSecret).not.toHaveBeenCalled();
});
it('uses a shared derivation and refuses missing keys instead of generating per-pod tokens', () => {
  mockSetupToken = '';
  expect(() => getSetupToken()).toThrow('shared setup token');
  process.env.ENCRYPTION_KEY = 'shared-encryption-key';
  expect(getSetupToken()).toBe(
    createHmac('sha256', 'shared-encryption-key').update('lifecycle-setup-token').digest('hex').slice(0, 32)
  );
  expect(mockLogger.info).not.toHaveBeenCalled();
});
it('completes a fresh setup, verifies the installation and retains unrelated data', async () => {
  await install();
  const response = await configure(post('configure'));
  expect(response.status).toBe(200);
  expect(mockLock).toHaveBeenCalledWith('app_setup');
  expect(mockRecords.app_setup).toMatchObject({ phase: 'complete', retained: 'setting', state: '', restarted: true });
  expect(decodeSecret('GITHUB_APP_INSTALLATION_ID')).toBe('456');
  expect(decodeSecret('OTHER_KEY')).toBe('preserved');
  expect(mockSecret.metadata.annotations.existing).toBe('annotation');
  expect(mockRecords.domainDefaults).toEqual({ http: 'example.test', grpc: 'example.test', publicScheme: 'https' });
  expect(mockRecords.lifecycleDefaults).toEqual({
    ecrDomain: 'distribution.example.test',
    defaultPublicUrl: 'dev-0.example.test',
    extra: true,
  });
  expect(global.fetch).toHaveBeenCalledWith(
    'https://api.github.com/app/installations/456',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer app-jwt' }) })
  );
  expect(mockExec).toHaveBeenCalledWith(
    'kubectl',
    [
      'rollout',
      'restart',
      'deployment',
      '-l',
      'app.kubernetes.io/instance=lifecycle,app.kubernetes.io/name=lifecycle',
      '-n',
      'lifecycle',
    ],
    { timeout: 15000 },
    expect.any(Function)
  );
  expect((await configure(post('configure'))).status).toBe(403);
  expect((await manifest(post('manifest', { appName: 'replacement' }))).status).toBe(403);
});
it.each(['env', 'secret'])('locks configured %s credentials even if app_setup flags are false', async (source) => {
  if (source === 'env') mockEnvCredentials.GITHUB_APP_ID = '123';
  else mockSecret.data.GITHUB_APP_ID = Buffer.from('123').toString('base64');
  expect((await manifest(post('manifest', { appName: 'replacement' }))).status).toBe(403);
  expect(mockWriteSecret).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});
it('fails closed when the live bootstrap Secret cannot be read', async () => {
  mockReadSecret.mockRejectedValue({ response: { statusCode: 403 } });
  expect((await manifest(post('manifest', { appName: 'fresh-app' }))).status).toBe(503);
  expect(mockWriteSecret).not.toHaveBeenCalled();
});
it('rejects legacy, expired and wrong callback state before contacting GitHub', async () => {
  mockRecords.app_setup = { state: 'old-state', created: false };
  expect((await callback(req('callback?code=x&state=old-state'))).status).toBe(400);
  const state = await start();
  expect((await callback(req('callback?code=x&state=wrong'))).status).toBe(400);
  mockRecords.app_setup.expiresAt = Date.now() - 1;
  expect((await callback(req(`callback?code=x&state=${state}`))).status).toBe(400);
  expect(global.fetch).not.toHaveBeenCalled();
});
it('serializes concurrent callback replays and converts the manifest once', async () => {
  const state = await start();
  const responses = await Promise.all([
    callback(req(`callback?code=x&state=${state}`)),
    callback(req(`callback?code=x&state=${state}`)),
  ]);
  expect(responses.map((response) => response.status)).toEqual([307, 400]);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(mockWriteSecret).toHaveBeenCalledTimes(1);
});
it('recovers the same created App after the Secret is saved but the DB transaction fails', async () => {
  const state = await start();
  mockCommitFailure = true;
  expect((await callback(req(`callback?code=x&state=${state}`))).status).toBe(500);
  expect(mockRecords.app_setup.phase).toBe('manifest');
  expect(decodeSecret('GITHUB_APP_ID')).toBe('123');
  expect((await callback(req(`callback?code=x&state=${state}`))).status).toBe(307);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(mockWriteSecret).toHaveBeenCalledTimes(1);
});
it('does not adopt externally changed credentials that retained setup annotations', async () => {
  await create();
  mockSecret.data.GITHUB_CLIENT_SECRET = Buffer.from('operator-replacement').toString('base64');
  expect((await manifest(post('manifest'))).status).toBe(403);
  expect((await installed(req(`installed?installation_id=456&state=${mockRecords.app_setup.state}`))).status).toBe(403);
});
it('rejects an installation from another App without marking setup complete', async () => {
  const state = await create();
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ app_id: 999 }) });
  expect((await installed(req(`installed?installation_id=456&state=${state}`))).status).toBe(403);
  expect(mockRecords.app_setup.phase).toBe('installation');
  expect(mockSecret.data.GITHUB_APP_INSTALLATION_ID).toBeUndefined();
});
it('keeps installation callback retryable when its Secret write fails', async () => {
  const state = await create();
  mockWriteSecret.mockRejectedValueOnce(new Error('unavailable'));
  expect((await installed(req(`installed?installation_id=456&state=${state}`))).status).toBe(503);
  expect(mockRecords.app_setup.phase).toBe('installation');
  expect((await installed(req(`installed?installation_id=456&state=${state}`))).status).toBe(307);
});
it('preserves operator domain and registry settings and permits a failed restart to retry', async () => {
  await install();
  mockRecords.domainDefaults = { http: 'custom.test', grpc: 'grpc.custom.test', publicScheme: 'http' };
  mockRecords.lifecycleDefaults = { ecrDomain: 'registry.custom.test', defaultPublicUrl: 'dev.custom.test' };
  mockExec.mockImplementationOnce((_file, _args, _options, done) => done(new Error('unavailable')));
  expect((await configure(post('configure'))).status).toBe(503);
  expect(mockRecords.app_setup.phase).toBe('installed');
  expect((await configure(post('configure'))).status).toBe(200);
  expect(mockRecords.domainDefaults).toEqual({ http: 'custom.test', grpc: 'grpc.custom.test', publicScheme: 'http' });
  expect(mockRecords.lifecycleDefaults).toEqual({
    ecrDomain: 'registry.custom.test',
    defaultPublicUrl: 'dev.custom.test',
  });
});
it('returns no state or token from status and prevents caching bootstrap state responses', async () => {
  const response = await manifest(post('manifest', { appName: 'fresh-app' }));
  const payload = await response.json();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(payload.data.manifest.setup_url).toBe('https://lifecycle.example.test/api/setup/installed');
  expect(payload.data.manifest.redirect_url).toBe('https://lifecycle.example.test/api/setup/callback');
  const statusResponse = await status(req('status'));
  const statusText = await statusResponse.text();
  expect(statusText).not.toContain(mockRecords.app_setup.state);
  expect(statusText).not.toContain('operator-token');
  expect(statusResponse.headers.get('cache-control')).toBe('private, no-store');
});
