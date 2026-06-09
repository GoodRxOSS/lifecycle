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
