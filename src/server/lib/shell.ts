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
import { execFile } from 'child_process';
import shell, { ExecOptions } from 'shelljs';
import { shellQuote } from './shellQuote';

interface Options extends ExecOptions {
  debug?: boolean;
  redactCommand?: string;
}

export { shell };

export async function shellPromise(cmd: string, options: Options = {}): Promise<string> {
  const { debug, redactCommand, ...shellOpts } = options;
  const displayCommand = redactCommand || cmd;

  return new Promise((resolve, reject) => {
    const opts = {
      silent: !debug,
      ...shellOpts,
    };

    shell.exec(cmd, opts, (code, stdout, stderr) => {
      if (code !== 0) {
        if (stderr.length > 0) {
          getLogger().debug(`Shell command failed: cmd=${displayCommand} stderr=${stderr}`);
        }
        const options = opts ? JSON.stringify(opts) : '';
        reject(
          `shellPromise command failed:\nExit code: ${code}\nOptions: ${options}\nCommand:\n${displayCommand},\n\nstderr:\n${stderr}\n\nstdout:\n${stdout}`
        );
      } else {
        resolve(stdout);
      }
    });
  });
}

interface FileOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  redactCommand?: string;
  redactValues?: string[];
}

export function redactCommandOutput(output: string, values: string[] = []): string {
  return [...new Set(values)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((redacted, value) => redacted.split(value).join('[REDACTED]'), output);
}

export async function execFilePromise(file: string, args: string[], options: FileOptions = {}): Promise<string> {
  const { redactCommand, redactValues, ...execOptions } = options;
  const displayCommand = redactCommandOutput(redactCommand || [file, ...args].map(shellQuote).join(' '), redactValues);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...execOptions, shell: false, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const safeStderr = redactCommandOutput(stderr, redactValues);
        const safeStdout = redactCommandOutput(stdout, redactValues);
        if (stderr.length > 0) {
          getLogger().debug(`Command failed: cmd=${displayCommand} stderr=${safeStderr}`);
        }
        reject(
          `execFilePromise command failed:\nExit code: ${
            error.code ?? error.signal ?? 'unknown'
          }\nCommand:\n${displayCommand},\n\nstderr:\n${safeStderr}\n\nstdout:\n${safeStdout}`
        );
      }
    );
  });
}
