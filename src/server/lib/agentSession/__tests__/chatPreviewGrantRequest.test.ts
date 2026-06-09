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

async function loadParser() {
  jest.resetModules();
  process.env.APP_HOST = 'https://app.lifecycle.test';
  process.env.CHAT_PREVIEW_DOMAIN = 'preview.lifecycle.test';
  process.env.LIFECYCLE_MODE = 'all';
  return import('../chatPreviewGrantRequest');
}

describe('chatPreviewGrantRequest', () => {
  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  it('canonicalizes schemed and uppercase preview hosts before minting grants', async () => {
    const { parsePreviewGrantBody } = await loadParser();

    expect(
      parsePreviewGrantBody({
        sessionId: ' session-123 ',
        port: '3000',
        previewHost: 'HTTPS://3000--ABCDEF1234567890.preview.lifecycle.test/',
      })
    ).toEqual({
      sessionId: 'session-123',
      port: 3000,
      previewHost: '3000--abcdef1234567890.preview.lifecycle.test',
    });
  });

  it('rejects preview hosts for the wrong port or domain', async () => {
    const { parsePreviewGrantBody } = await loadParser();

    expect(() =>
      parsePreviewGrantBody({
        sessionId: 'session-123',
        port: 3000,
        previewHost: '3001--abcdef1234567890.preview.lifecycle.test',
      })
    ).toThrow(/previewHost/);
    expect(() =>
      parsePreviewGrantBody({
        sessionId: 'session-123',
        port: 3000,
        previewHost: '3000--abcdef1234567890.evil.test',
      })
    ).toThrow(/previewHost/);
  });

  it('rejects missing session ids and invalid ports', async () => {
    const { parsePreviewGrantBody } = await loadParser();

    expect(() => parsePreviewGrantBody({ port: 3000 })).toThrow(/sessionId/);
    expect(() => parsePreviewGrantBody({ sessionId: 'session-123', port: 0 })).toThrow(/port/);
    expect(() => parsePreviewGrantBody({ sessionId: 'session-123', port: 65536 })).toThrow(/port/);
    expect(() => parsePreviewGrantBody({ sessionId: 'session-123', port: 3000 })).toThrow(/previewHost/);
  });
});
