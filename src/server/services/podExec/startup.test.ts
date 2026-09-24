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

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('custom-server import order initializes the real Build model', () => {
  // Jest's model mocks and transformed module graph do not reproduce CommonJS startup cycles.
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
      '-e',
      `
    const assert = require('node:assert/strict');
    require('./src/server/services/podExec/upgrade');
    const models = require('./src/server/models');
    const Build = require('./src/server/models/Build').default;
    const BuildService = require('./src/server/services/build').default;
    assert.equal(typeof models.Build, 'function');
    assert.equal(models.Build, Build);
    assert.equal(new BuildService().db.models.Build, Build);
    assert.equal(typeof Build.query, 'function');
    process.exit(0);
  `,
    ],
    {
      cwd: resolve(__dirname, '../../../..'),
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.server.json', NODE_OPTIONS: '' },
      encoding: 'utf8',
      timeout: 30000,
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}, 35000);
