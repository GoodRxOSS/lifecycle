import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockDebug = jest.fn();
jest.mock('server/lib/logger', () => ({ getLogger: () => ({ debug: mockDebug }) }));

import { execFilePromise, redactCommandOutput } from '../shell';

describe('execFilePromise process boundary', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'lfc-command-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('passes spaces, quotes, substitutions, newlines and option-like text literally', async () => {
    const marker = join(directory, 'unexpected');
    const args = [
      '',
      'two words',
      "O'Hare",
      '$HOME',
      '`uname`',
      `$(touch ${marker})`,
      `; touch ${marker}`,
      'line\nnext',
      '--flag',
      '雪',
    ];
    const output = await execFilePromise(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      '--',
      ...args,
    ]);
    expect(JSON.parse(output)).toEqual(args);
    expect(existsSync(marker)).toBe(false);
  });

  it('preserves stdout and nonfatal stderr, cwd and explicit environment', async () => {
    const output = await execFilePromise(
      process.execPath,
      [
        '-e',
        'process.stderr.write("warning");process.stdout.write(JSON.stringify([process.cwd(),process.env.LFC_TEST]))',
      ],
      {
        cwd: directory,
        env: { LFC_TEST: 'literal value' },
      }
    );
    expect(JSON.parse(output)).toEqual([realpathSync(directory), 'literal value']);
  });

  it('keeps the shell runner output budget above the Node default', async () => {
    const output = await execFilePromise(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']);
    expect(output.length).toBe(2 * 1024 * 1024);
  });

  it('rejects with string diagnostics and the redacted command instead of Node’s raw command error', async () => {
    const failure = await execFilePromise(
      process.execPath,
      ['-e', 'process.stdout.write("partial");process.stderr.write("denied");process.exit(2)', 'synthetic-secret'],
      {
        redactCommand: 'test-tool [REDACTED]',
      }
    ).catch((error) => error);
    expect(typeof failure).toBe('string');
    expect(failure).toContain('Exit code: 2');
    expect(failure).toContain('test-tool [REDACTED]');
    expect(failure).toContain('denied');
    expect(failure).toContain('partial');
    expect(failure).not.toContain('synthetic-secret');
    expect(JSON.stringify(mockDebug.mock.calls)).not.toContain('synthetic-secret');
  });

  it('enforces timeout and reports an unavailable executable', async () => {
    await expect(
      execFilePromise(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 })
    ).rejects.toContain('SIGTERM');
    await expect(execFilePromise(join(directory, 'missing-tool'), [])).rejects.toContain('ENOENT');
  });

  it('redacts known values echoed on either failure stream but preserves successful stdout', async () => {
    const secret = "synthetic' $value";
    const script = 'process.stdout.write(process.argv[1]);process.stderr.write(process.argv[1]);process.exit(2)';
    const failure = await execFilePromise(process.execPath, ['-e', script, secret], {
      redactCommand: 'test-tool [REDACTED]',
      redactValues: ['', secret, secret],
    }).catch((error) => error);
    expect(failure).not.toContain(secret);
    expect(failure).toContain('stderr:\n[REDACTED]\n\nstdout:\n[REDACTED]');
    expect(JSON.stringify(mockDebug.mock.calls)).not.toContain(secret);
    await expect(
      execFilePromise(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', secret], {
        redactValues: [secret],
      })
    ).resolves.toBe(secret);
    expect(redactCommandOutput('long-secret secret', ['secret', 'long-secret'])).toBe('[REDACTED] [REDACTED]');
  });
});
