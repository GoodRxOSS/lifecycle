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

import { importEsm } from './esmImport';

describe('importEsm', () => {
  it('uses the Jest-compatible require path for a CommonJS-loadable module', async () => {
    const path = await importEsm<typeof import('path')>('path');

    expect(path.join('workspace', 'repo')).toBe('workspace/repo');
  });

  it('preserves a non-ESM require failure', async () => {
    await expect(importEsm('lifecycle-module-that-does-not-exist')).rejects.toMatchObject({
      code: 'MODULE_NOT_FOUND',
    });
  });
});
