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

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const TRACE_BOOTSTRAP = 'dd-trace-init.js';

describe('Datadog trace bootstrap', () => {
  it('does not shadow the dd-trace package under the runtime TypeScript loader', () => {
    const resolved = execFileSync(
      process.execPath,
      ['--require', 'tsx/cjs', '--eval', "process.stdout.write(require.resolve('dd-trace'))"],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(ROOT, 'tsconfig.json'),
        },
      }
    );

    expect(path.relative(ROOT, resolved)).toMatch(/^node_modules[\\/]/);
  });

  it('preloads the distinct bootstrap filename in development and production', () => {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(existsSync(path.join(ROOT, TRACE_BOOTSTRAP))).toBe(true);
    expect(packageJson.scripts.dev).toContain(`-r ./${TRACE_BOOTSTRAP}`);
    expect(packageJson.scripts.start).toContain(`-r ./${TRACE_BOOTSTRAP}`);
  });
});
