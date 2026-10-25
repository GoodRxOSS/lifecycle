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

import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(name) : /\.[jt]sx?$/.test(name) ? [name] : [];
  });
}

it('does not register the retired v1 API in either Next router', () => {
  expect(sourceFiles(path.join(root, 'src/pages/api/v1'))).toEqual([]);
  expect(sourceFiles(path.join(root, 'src/app/api/v1'))).toEqual([]);
});

it('does not leave first-party pages or the environment banner calling the retired API', () => {
  const files = [...sourceFiles(path.join(root, 'src/pages')), path.join(root, 'public/utils/0-banner.js')];
  const callers = files.filter((file) => readFileSync(file, 'utf8').includes('/api/v1'));
  expect(callers).toEqual([]);
  expect(readFileSync(path.join(root, 'public/utils/0-banner.js'), 'utf8')).not.toContain('new EventSource');
});
