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

import { buildLifecycleUiEnvironmentUrl } from '../tools/core/environmentUrl';

describe('MCP Lifecycle UI environment URL', () => {
  it('joins a configured base path and encodes the environment name', () => {
    expect(buildLifecycleUiEnvironmentUrl('preview/name', 'https://lifecycle.example.test/app/')).toBe(
      'https://lifecycle.example.test/app/environments/preview%2Fname'
    );
  });

  it.each([
    '',
    'not-a-url',
    'ftp://lifecycle.example.test',
    'https://user:secret@lifecycle.example.test',
    'https://lifecycle.example.test?source=mcp',
    'https://lifecycle.example.test#status',
  ])('omits an unsafe or unusable base URL: %s', (baseUrl) => {
    expect(buildLifecycleUiEnvironmentUrl('preview-123456', baseUrl)).toBeUndefined();
  });

  it('omits the URL when the environment name is empty', () => {
    expect(buildLifecycleUiEnvironmentUrl('   ', 'https://lifecycle.example.test')).toBeUndefined();
  });
});
