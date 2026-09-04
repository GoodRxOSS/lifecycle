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

type ShellCallback = (code: number, stdout: string, stderr: string) => void;

const mockShellExec = jest.fn();
const mockLoggerDebug = jest.fn();

jest.mock('shelljs', () => ({
  __esModule: true,
  default: {
    exec: (...args: unknown[]) => mockShellExec(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
  }),
}));

const { shellPromise } = require('../shell') as typeof import('../shell');

describe('shellPromise', () => {
  let callback: ShellCallback | undefined;
  let childProcess: { kill: jest.Mock };

  beforeEach(() => {
    callback = undefined;
    childProcess = { kill: jest.fn() };
    mockLoggerDebug.mockReset();
    mockShellExec.mockReset().mockImplementation((_command, _options, execCallback: ShellCallback) => {
      callback = execCallback;
      return childProcess;
    });
  });

  const complete = (code: number, stdout: string, stderr: string): void => {
    expect(callback).toBeDefined();
    callback?.(code, stdout, stderr);
  };

  it('resolves stdout using silent execution defaults', async () => {
    const result = shellPromise('tool --flag "two words"');

    expect(mockShellExec).toHaveBeenCalledWith('tool --flag "two words"', { silent: true }, expect.any(Function));

    complete(0, 'command output\n', 'non-fatal warning\n');

    await expect(result).resolves.toBe('command output\n');
    expect(mockLoggerDebug).not.toHaveBeenCalled();
    expect(childProcess.kill).not.toHaveBeenCalled();
  });

  it('passes multiline stdin-style commands and process options through without mutation', async () => {
    const command = "cat <<'EOF' | consumer --stdin\npayload\nEOF";
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: '/usr/local/bin', SERVICE_TOKEN: 'opaque-token' };
    const options = {
      cwd: '/workspace/service',
      debug: true,
      encoding: 'utf8',
      env,
      silent: true,
      timeout: 2_500,
    };

    const result = shellPromise(command, options);

    expect(mockShellExec).toHaveBeenCalledWith(
      command,
      {
        silent: true,
        cwd: '/workspace/service',
        encoding: 'utf8',
        env,
        timeout: 2_500,
      },
      expect.any(Function)
    );
    expect(options).toEqual({
      cwd: '/workspace/service',
      debug: true,
      encoding: 'utf8',
      env,
      silent: true,
      timeout: 2_500,
    });

    complete(0, '', '');
    await expect(result).resolves.toBe('');
  });

  it('makes output visible in debug mode unless silent is explicitly overridden', async () => {
    const debugResult = shellPromise('debug-command', { debug: true });
    expect(mockShellExec).toHaveBeenLastCalledWith('debug-command', { silent: false }, expect.any(Function));
    complete(0, 'debug output', '');
    await expect(debugResult).resolves.toBe('debug output');

    const visibleResult = shellPromise('visible-command', { debug: false, silent: false });
    expect(mockShellExec).toHaveBeenLastCalledWith('visible-command', { silent: false }, expect.any(Function));
    complete(0, 'visible output', '');
    await expect(visibleResult).resolves.toBe('visible output');
  });

  it('redacts a failed command from logs and rejection details while preserving diagnostics', async () => {
    const command = 'deploy --token super-secret';
    const displayCommand = 'deploy --token [REDACTED]';
    const result = shellPromise(command, {
      killSignal: 'SIGKILL',
      redactCommand: displayCommand,
      timeout: 250,
    });

    expect(mockShellExec).toHaveBeenCalledWith(
      command,
      { silent: true, killSignal: 'SIGKILL', timeout: 250 },
      expect.any(Function)
    );

    complete(137, 'partial output', 'process timed out');

    const expectedFailure =
      'shellPromise command failed:\n' +
      'Exit code: 137\n' +
      'Options: {"silent":true,"killSignal":"SIGKILL","timeout":250}\n' +
      `Command:\n${displayCommand},\n\n` +
      'stderr:\nprocess timed out\n\n' +
      'stdout:\npartial output';
    await expect(result).rejects.toBe(expectedFailure);
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      `Shell command failed: cmd=${displayCommand} stderr=process timed out`
    );
    expect(expectedFailure).not.toContain('super-secret');
    expect(childProcess.kill).not.toHaveBeenCalled();
  });

  it('rejects a nonzero exit without logging when stderr is empty', async () => {
    const result = shellPromise('quiet-failure');

    complete(2, 'partial output', '');

    await expect(result).rejects.toBe(
      'shellPromise command failed:\n' +
        'Exit code: 2\n' +
        'Options: {"silent":true}\n' +
        'Command:\nquiet-failure,\n\n' +
        'stderr:\n\n\n' +
        'stdout:\npartial output'
    );
    expect(mockLoggerDebug).not.toHaveBeenCalled();
  });

  it('propagates a synchronous shell startup failure without waiting for a callback', async () => {
    const startupError = new Error('unable to start shell');
    mockShellExec.mockImplementationOnce(() => {
      throw startupError;
    });

    await expect(shellPromise('unavailable-command')).rejects.toBe(startupError);

    expect(callback).toBeUndefined();
    expect(mockLoggerDebug).not.toHaveBeenCalled();
    expect(childProcess.kill).not.toHaveBeenCalled();
  });
});
