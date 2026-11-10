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

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');

function serverCompilerOptions(): ts.CompilerOptions {
  const configPath = path.join(ROOT, 'tsconfig.server.json');
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT, undefined, configPath).options;
}

// ws-server (and the MCP tools it serves) runs from tsc output. Emitted class fields would
// overwrite every property of an Objection model instance that `$query().patch()` touches.
describe('server TypeScript compilation', () => {
  it('does not emit declared model properties as class fields', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/server/models/Deploy.ts'), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: serverCompilerOptions() });

    expect(outputText).not.toMatch(/^\s*deployableId;$/m);
    expect(outputText).not.toMatch(/^\s*status;$/m);
  });
});
