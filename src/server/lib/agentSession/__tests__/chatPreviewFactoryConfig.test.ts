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

const originalEnv = { ...process.env };

async function loadFactory(env: Record<string, string | undefined>) {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    APP_HOST: 'https://api.lifecycle.test',
    CHAT_PREVIEW_HOST_SECRET: 'test-host-secret',
    LIFECYCLE_MODE: 'all',
    ...env,
  };
  return import('../chatPreviewFactory');
}

describe('chatPreviewFactory configuration', () => {
  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  it('builds deterministic 32-hex host slugs and parses configured preview hosts', async () => {
    const factory = await loadFactory({
      CHAT_PREVIEW_DOMAIN: 'preview.lifecycle.test',
      LIFECYCLE_UI_URL: 'https://app.lifecycle.test',
    });

    const first = factory.buildChatPreviewHostSlug({
      sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      port: 3000,
    });
    const second = factory.buildChatPreviewHostSlug({
      sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      port: 3000,
    });

    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(second).toBe(first);
    expect(factory.buildChatPreviewHost({ port: 3000, previewSlug: first })).toBe(
      `3000--${first}.preview.lifecycle.test`
    );
    expect(factory.parseChatPreviewHost(`HTTPS://3000--${first.toUpperCase()}.preview.lifecycle.test/`)).toEqual({
      port: 3000,
      previewSlug: first,
      host: `3000--${first}.preview.lifecycle.test`,
    });
    expect(factory.parseChatPreviewHost(`3000--${first}.evil.test`)).toBeNull();
  });

  it('normalizes the configured domain and publishes the corresponding host URL', async () => {
    const factory = await loadFactory({
      APP_HOST: 'https://api.lifecycle.test',
      CHAT_PREVIEW_DOMAIN: ' HTTPS://Preview.Lifecycle.Test/// ',
      LIFECYCLE_UI_URL: 'https://app.lifecycle.test',
    });

    expect(factory.resolveChatPreviewHostDomain()).toBe('preview.lifecycle.test');
    expect(factory.resolveChatPreviewHostProtocol()).toBe('https:');
    expect(factory.buildChatPreviewResolverPath('session-1', 4173)).toBe('/preview/session-1/4173');
    expect(factory.buildChatPreviewResolverUrl({ sessionUuid: 'session-1', port: 4173 })).toBe(
      'https://app.lifecycle.test/preview/session-1/4173'
    );
    expect(
      factory.resolveChatPreviewPublicPublication({
        port: 4173,
        previewSlug: 'abcdef1234567890abcdef1234567890',
      })
    ).toEqual({
      url: 'https://4173--abcdef1234567890abcdef1234567890.preview.lifecycle.test/',
      host: '4173--abcdef1234567890abcdef1234567890.preview.lifecycle.test',
      path: '/',
    });
  });

  it('rejects absent, malformed, and out-of-range host headers', async () => {
    const factory = await loadFactory({
      CHAT_PREVIEW_DOMAIN: 'preview.lifecycle.test',
      LIFECYCLE_UI_URL: 'https://app.lifecycle.test',
    });

    expect(factory.parseChatPreviewHost(undefined)).toBeNull();
    expect(factory.parseChatPreviewHost('3000--short.preview.lifecycle.test')).toBeNull();
    expect(factory.parseChatPreviewHost('0--abcdef.preview.lifecycle.test')).toBeNull();
    expect(factory.parseChatPreviewHost('65536--abcdef.preview.lifecycle.test')).toBeNull();
  });

  it('uses the localhost API origin as the preview domain when no domain is configured', async () => {
    const factory = await loadFactory({
      APP_HOST: 'http://localhost:5001',
      CHAT_PREVIEW_DOMAIN: '',
      LIFECYCLE_UI_URL: '',
    });

    expect(factory.resolveChatPreviewHostDomain()).toBe('localhost:5001');
    expect(factory.buildChatPreviewHost({ port: 3000, previewSlug: 'abcdef' })).toBe('3000--abcdef.localhost:5001');
    expect(factory.buildChatPreviewResolverUrl({ sessionUuid: 'session-1', port: 3000 })).toBe(
      'http://localhost:3000/preview/session-1/3000'
    );
  });

  it('uses bare localhost and otherwise disables host publication without a configured domain', async () => {
    const localhostFactory = await loadFactory({
      APP_HOST: 'http://localhost',
      CHAT_PREVIEW_DOMAIN: '',
      LIFECYCLE_UI_URL: '',
    });
    expect(localhostFactory.resolveChatPreviewHostDomain()).toBe('localhost');

    const remoteFactory = await loadFactory({
      APP_HOST: 'https://api.lifecycle.test',
      CHAT_PREVIEW_DOMAIN: '',
      LIFECYCLE_UI_URL: '',
    });
    expect(remoteFactory.resolveChatPreviewHostDomain()).toBeNull();
    expect(remoteFactory.buildChatPreviewHost({ port: 3000, previewSlug: 'abcdef' })).toBeNull();
    expect(remoteFactory.buildChatPreviewResolverUrl({ sessionUuid: 'session-1', port: 3000 })).toBe(
      'https://api.lifecycle.test/preview/session-1/3000'
    );
  });

  it('uses the documented local-development secret only when authentication is disabled', async () => {
    const localFactory = await loadFactory({
      CHAT_PREVIEW_DOMAIN: 'preview.lifecycle.test',
      CHAT_PREVIEW_HOST_SECRET: '',
      CHAT_PREVIEW_GRANT_SECRET: '',
      ENABLE_AUTH: 'false',
      ENCRYPTION_KEY: '',
      GITHUB_WEBHOOK_SECRET: '',
      NEXTAUTH_SECRET: '',
    });

    expect(
      localFactory.buildChatPreviewHostSlug({
        sessionUuid: 'session-1',
        port: 3000,
      })
    ).toMatch(/^[a-f0-9]{32}$/);

    const authenticatedFactory = await loadFactory({
      CHAT_PREVIEW_DOMAIN: 'preview.lifecycle.test',
      CHAT_PREVIEW_HOST_SECRET: 'changeme',
      CHAT_PREVIEW_GRANT_SECRET: '',
      ENABLE_AUTH: 'true',
      ENCRYPTION_KEY: '',
      GITHUB_WEBHOOK_SECRET: '',
      NEXTAUTH_SECRET: '',
    });

    expect(() =>
      authenticatedFactory.buildChatPreviewHostSlug({
        sessionUuid: 'session-1',
        port: 3000,
      })
    ).toThrow(/CHAT_PREVIEW_HOST_SECRET or ENCRYPTION_KEY/);
  });

  it('accepts the fallback grant secret when the host secret is absent', async () => {
    const factory = await loadFactory({
      CHAT_PREVIEW_DOMAIN: 'preview.lifecycle.test',
      CHAT_PREVIEW_HOST_SECRET: '',
      CHAT_PREVIEW_GRANT_SECRET: 'grant-secret',
      ENABLE_AUTH: 'true',
      ENCRYPTION_KEY: '',
      GITHUB_WEBHOOK_SECRET: '',
      NEXTAUTH_SECRET: '',
    });

    expect(factory.buildChatPreviewHostSlug({ sessionUuid: 'session-1', port: 3000 })).toMatch(/^[a-f0-9]{32}$/);
  });

  it('requires a host preview domain for public remote preview publication', async () => {
    const factory = await loadFactory({
      CHAT_PREVIEW_DOMAIN: '',
      LIFECYCLE_UI_URL: 'https://app.lifecycle.test',
    });

    expect(() =>
      factory.resolveChatPreviewPublicPublication({
        port: 3000,
        previewSlug: 'abcdef1234567890abcdef1234567890',
      })
    ).toThrow(/CHAT_PREVIEW_DOMAIN/);
  });

  it('requires the UI resolver base when host preview domains are configured outside localhost', async () => {
    const factory = await loadFactory({
      CHAT_PREVIEW_DOMAIN: 'preview.lifecycle.test',
      LIFECYCLE_UI_URL: '',
    });

    expect(() =>
      factory.buildChatPreviewResolverUrl({
        sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        port: 3000,
      })
    ).toThrow(/LIFECYCLE_UI_URL/);
  });
});
