/**
 * Copyright 2025 GoodRx, Inc.
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

import { getLogger } from 'server/lib/logger';
import shell, { ExecOptions } from 'shelljs';

interface Options extends ExecOptions {
  debug?: boolean;
}

export { shell };

export async function shellPromise(cmd: string, options: Options = {}): Promise<string> {
  const { debug, ...shellOpts } = options;

  return new Promise((resolve, reject) => {
    const opts = {
      silent: !debug,
      ...shellOpts,
    };

    shell.exec(cmd, opts, (code, stdout, stderr) => {
      if (code !== 0) {
        if (stderr.length > 0) {
          getLogger().debug(`Shell command failed: cmd=${cmd} stderr=${stderr}`);
        }
        const options = opts ? JSON.stringify(opts) : '';
        reject(
          `shellPromise command failed:\nExit code: ${code}\nOptions: ${options}\nCommand:\n${cmd},\n\nstderr:\n${stderr}\n\nstdout:\n${stdout}`
        );
      } else {
        resolve(stdout);
      }
    });
  });
}
