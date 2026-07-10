import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'lfc-gateway-ops-'));
process.env.LIFECYCLE_SESSION_WORKSPACE = workspaceRoot;
process.env.LIFECYCLE_SESSION_PRIMARY_REPO_PATH = workspaceRoot;
process.env.LIFECYCLE_SANDBOX_DEFAULT_OPERATION_MAX_DURATION_MS = '2000';
process.env.LIFECYCLE_SANDBOX_MAX_OPERATION_DURATION_MS = '5000';
process.env.LIFECYCLE_SANDBOX_MAX_OPERATION_WAIT_MS = '5000';
process.env.LIFECYCLE_SANDBOX_MAX_COMMAND_OUTPUT_CHARS = '2000';
process.env.LIFECYCLE_SANDBOX_MAX_OPERATION_LOG_CHARS = '80';
process.env.LIFECYCLE_SANDBOX_OPERATION_KILL_GRACE_MS = '300';
process.env.LIFECYCLE_SANDBOX_MAX_SERVICE_LOG_CHARS = '80';
process.env.LIFECYCLE_SANDBOX_SERVICE_STOP_GRACE_MS = '300';

const gateway = await import(new URL(`./index.mjs?operations-test=${Date.now()}`, import.meta.url));

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test.after(async () => {
  await gateway.cancelAllWorkspaceOperations({ waitMs: 1000 }).catch(() => {});
  for (const service of gateway.listWorkspaceServices({ includeStopped: false }).services) {
    await gateway.stopWorkspaceService(service.name, { waitMs: 2000 }).catch(() => {});
  }
  await rm(workspaceRoot, { recursive: true, force: true });
});

test('workspace command keeps the synchronous result shape by default', async () => {
  const result = await gateway.runWorkspaceCommand({
    command: 'printf "hello"',
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.success, true);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, '');
  assert.match(result.operationId, /^op_/);
});

test('workspace command can return a running operation handle and wait later', async () => {
  const started = await gateway.runWorkspaceCommand({
    command: 'sleep 0.2; printf "done"',
    async: true,
    maxDurationMs: 2000,
  });

  assert.equal(started.status, 'running');
  assert.equal(started.running, true);
  assert.match(started.operationId, /^op_/);

  const completed = await gateway.waitForWorkspaceOperation(started.operationId, {
    waitMs: 2000,
    includeLogs: true,
  });

  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.running, false);
  assert.equal(completed.stdout, 'done');
});

test('workspace operation cancel terminates a running command', async () => {
  const started = await gateway.runWorkspaceCommand({
    command: 'sleep 5',
    async: true,
    maxDurationMs: 5000,
  });

  const cancelResult = gateway.cancelWorkspaceOperation(started.operationId);
  assert.equal(cancelResult.cancellationRequested, true);

  const completed = await gateway.waitForWorkspaceOperation(started.operationId, {
    waitMs: 2000,
    includeLogs: true,
  });

  assert.equal(completed.status, 'canceled');
  assert.equal(completed.success, false);
});

test('workspace operation cancel terminates descendant processes', async () => {
  const leakPath = resolve(workspaceRoot, 'operation-descendant-leak.txt');
  const started = await gateway.runWorkspaceCommand({
    command: '(sleep 0.8; printf "leaked" > operation-descendant-leak.txt) & wait',
    async: true,
    maxDurationMs: 5000,
  });

  const cancelResult = gateway.cancelWorkspaceOperation(started.operationId);
  assert.equal(cancelResult.cancellationRequested, true);

  const completed = await gateway.waitForWorkspaceOperation(started.operationId, {
    waitMs: 2000,
    includeLogs: true,
  });

  assert.equal(completed.status, 'canceled');
  assert.equal(completed.running, false);
  await delay(1000);
  assert.equal(await fileExists(leakPath), false);
});

test('workspace operation cancel is not overwritten by a later timeout', async () => {
  const started = await gateway.runWorkspaceCommand({
    command: 'trap "" TERM; printf "ready\\n"; (trap "" TERM; sleep 5) & wait',
    async: true,
    maxDurationMs: 1500,
  });

  // Loaded CI runners can take well over 100ms to spawn the shell and flush stdout;
  // poll for the marker instead of trusting a single short wait.
  const readyDeadline = Date.now() + 1000;
  let ready = await gateway.waitForWorkspaceOperation(started.operationId, {
    waitMs: 100,
    includeLogs: true,
  });
  while (!/ready/.test(ready.stdout ?? '') && Date.now() < readyDeadline) {
    ready = await gateway.waitForWorkspaceOperation(started.operationId, {
      waitMs: 100,
      includeLogs: true,
    });
  }
  assert.equal(ready.status, 'running');
  assert.match(ready.stdout, /ready/);

  const cancelResult = gateway.cancelWorkspaceOperation(started.operationId);
  assert.equal(cancelResult.cancellationRequested, true);

  const completed = await gateway.waitForWorkspaceOperation(started.operationId, {
    waitMs: 1000,
    includeLogs: true,
  });

  assert.equal(completed.status, 'canceled');
  assert.equal(completed.running, false);

  // The maxDurationMs timer fires after the cancel; the regression under test is that it
  // must not overwrite the terminal 'canceled' status.
  await delay(1200);
  const afterTimeout = await gateway.waitForWorkspaceOperation(started.operationId, {
    waitMs: 100,
    includeLogs: true,
  });
  assert.equal(afterTimeout.status, 'canceled');
});

test('workspace operation logs return bounded tails with truncation metadata', async () => {
  const completed = await gateway.runWorkspaceCommand({
    command: 'node -e "process.stdout.write(\'A\'.repeat(120)); process.stderr.write(\'B\'.repeat(120))"',
    async: true,
    waitMs: 2000,
  });

  assert.equal(completed.status, 'succeeded');

  const logs = gateway.readWorkspaceOperationLogs(completed.operationId, {
    stream: 'both',
    maxChars: 10,
  });

  assert.equal(logs.stdoutTruncated, true);
  assert.equal(logs.stderrTruncated, true);
  assert.match(logs.stdout, /^\[truncated oldest 110 chars\]\nA{10}$/);
  assert.match(logs.stderr, /^\[truncated oldest 110 chars\]\nB{10}$/);
});

test('workspace operation list can exclude completed operations', async () => {
  const started = await gateway.runWorkspaceCommand({
    command: 'sleep 0.2',
    async: true,
    maxDurationMs: 2000,
  });

  const runningList = gateway.listWorkspaceOperations({
    includeCompleted: false,
    limit: 100,
  });
  assert.ok(runningList.operations.some((operation) => operation.operationId === started.operationId));

  await gateway.waitForWorkspaceOperation(started.operationId, {
    waitMs: 2000,
  });

  const runningOnly = gateway.listWorkspaceOperations({
    includeCompleted: false,
    limit: 100,
  });
  assert.equal(runningOnly.operations.some((operation) => operation.operationId === started.operationId), false);

  const retained = gateway.listWorkspaceOperations({
    includeCompleted: true,
    limit: 100,
  });
  assert.ok(retained.operations.some((operation) => operation.operationId === started.operationId));
});

test('workspace command captures file changes after operation completion', async () => {
  await writeFile(resolve(workspaceRoot, 'sample.txt'), 'before\n', 'utf8');

  const result = await gateway.runWorkspaceCommand({
    command: 'printf "after\\n" > sample.txt',
    captureFileChanges: true,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(await readFile(resolve(workspaceRoot, 'sample.txt'), 'utf8'), 'after\n');
  assert.equal(result.fileChanges.length, 1);
  assert.equal(result.fileChanges[0].path, 'sample.txt');
  assert.equal(result.fileChanges[0].kind, 'edited');
});

test('workspace command rejects a cwd symlink that resolves outside the workspace', async () => {
  const outsideRoot = await mkdtemp(resolve(tmpdir(), 'lfc-gateway-outside-'));
  const linkPath = resolve(workspaceRoot, 'outside-link');

  try {
    await symlink(outsideRoot, linkPath);

    await assert.rejects(
      () =>
        gateway.runWorkspaceCommand({
          command: 'pwd',
          cwd: 'outside-link',
        }),
      /Path resolves outside the workspace root/
    );
  } finally {
    await rm(linkPath, { force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('workspace file tools deny symlink escapes on read and write', async () => {
  const externalRoot = await mkdtemp(resolve(tmpdir(), 'lfc-gateway-outside-'));
  const externalFile = resolve(externalRoot, 'secret.txt');
  await writeFile(externalFile, 'outside\n', 'utf8');
  await symlink(externalFile, resolve(workspaceRoot, 'outside-file-link.txt'));
  await symlink(externalRoot, resolve(workspaceRoot, 'outside-dir-link'));

  try {
    await assert.rejects(
      gateway.readWorkspaceFile({ path: 'outside-file-link.txt' }),
      /outside the workspace|stay within/
    );
    await assert.rejects(
      gateway.writeWorkspaceFile('outside-file-link.txt', 'changed\n'),
      /outside the workspace|stay within/
    );
    await assert.rejects(
      gateway.writeWorkspaceFile('outside-dir-link/leak.txt', 'leak\n'),
      /outside the workspace|stay within/
    );
    assert.equal(await readFile(externalFile, 'utf8'), 'outside\n');
    assert.equal(await fileExists(resolve(externalRoot, 'leak.txt')), false);
  } finally {
    await rm(resolve(workspaceRoot, 'outside-file-link.txt'), { force: true });
    await rm(resolve(workspaceRoot, 'outside-dir-link'), { force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('workspace file tools deny protected repo and user credential paths', async () => {
  for (const path of [
    '.env',
    '.env.local',
    'app/.env',
    '.npmrc',
    '.netrc',
    '.ssh/id_rsa',
    '.git/config',
    '.git/hooks/pre-commit',
  ]) {
    await assert.rejects(
      gateway.writeWorkspaceFile(path, 'secret\n'),
      (error) => error?.code === 'protected_path' && /protected/.test(error.message),
      path
    );
  }
});

test('workspace file tools deny protected paths after symlink resolution', async () => {
  await writeFile(resolve(workspaceRoot, '.npmrc'), '//registry.example/:_authToken=secret\n', 'utf8');
  await symlink(resolve(workspaceRoot, '.npmrc'), resolve(workspaceRoot, 'safe-looking-link'));

  await assert.rejects(
    gateway.readWorkspaceFile({ path: 'safe-looking-link' }),
    (error) => error?.code === 'protected_path' && /protected/.test(error.message)
  );
});

test('workspace list files returns bounded entries and skips protected paths', async () => {
  await writeFile(resolve(workspaceRoot, 'listed.txt'), 'visible\n', 'utf8');
  await writeFile(resolve(workspaceRoot, '.env.local'), 'secret\n', 'utf8');

  const result = await gateway.listWorkspaceFiles({ path: '.', depth: 1, includeHidden: true, limit: 50 });

  assert.ok(result.entries.some((entry) => entry.path === 'listed.txt' && entry.kind === 'file'));
  assert.equal(result.entries.some((entry) => entry.path === '.env.local'), false);

  const bounded = await gateway.listWorkspaceFiles({ path: '.', depth: 1, limit: 1 });
  assert.equal(bounded.entries.length, 1);
  assert.equal(bounded.truncated, true);
});

test('workspace list files denies symlink escapes', async () => {
  const externalRoot = await mkdtemp(resolve(tmpdir(), 'lfc-gateway-list-outside-'));
  const linkPath = resolve(workspaceRoot, 'list-outside-link');

  try {
    await symlink(externalRoot, linkPath);

    await assert.rejects(
      gateway.listWorkspaceFiles({ path: 'list-outside-link', depth: 1 }),
      /outside the workspace|stay within/
    );

    const result = await gateway.listWorkspaceFiles({ path: '.', depth: 1, includeHidden: true, limit: 200 });
    assert.equal(result.entries.some((entry) => entry.path === 'list-outside-link'), false);
  } finally {
    await rm(linkPath, { force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('workspace apply patch edits files and reports file changes', async () => {
  await writeFile(resolve(workspaceRoot, 'patch-target.txt'), 'before\n', 'utf8');

  const result = await gateway.applyWorkspacePatch({
    patch: [
      '*** Begin Patch',
      '*** Update File: patch-target.txt',
      '@@',
      '-before',
      '+after',
      '*** End Patch',
    ].join('\n'),
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.changedFiles, ['patch-target.txt']);
  assert.deepEqual(result.changed_files, ['patch-target.txt']);
  assert.match(result.diff, /-before/);
  assert.match(result.diff, /\+after/);
  assert.equal(await readFile(resolve(workspaceRoot, 'patch-target.txt'), 'utf8'), 'after\n');
  assert.equal(result.fileChanges[0].kind, 'edited');
});

test('workspace apply patch denies protected paths', async () => {
  await assert.rejects(
    gateway.applyWorkspacePatch({
      patch: ['*** Begin Patch', '*** Add File: app/.env', '+secret=value', '*** End Patch'].join('\n'),
    }),
    (error) => error?.code === 'protected_path' && /protected/.test(error.message)
  );

  assert.equal(await fileExists(resolve(workspaceRoot, 'app/.env')), false);
});

test('workspace apply patch denies symlink escapes', async () => {
  const externalRoot = await mkdtemp(resolve(tmpdir(), 'lfc-gateway-patch-outside-'));
  const externalFile = resolve(externalRoot, 'secret.txt');
  const linkPath = resolve(workspaceRoot, 'patch-outside-link.txt');

  try {
    await writeFile(externalFile, 'outside\n', 'utf8');
    await symlink(externalFile, linkPath);

    await assert.rejects(
      gateway.applyWorkspacePatch({
        patch: [
          '*** Begin Patch',
          '*** Update File: patch-outside-link.txt',
          '@@',
          '-outside',
          '+changed',
          '*** End Patch',
        ].join('\n'),
      }),
      /outside the workspace|stay within/
    );

    assert.equal(await readFile(externalFile, 'utf8'), 'outside\n');
  } finally {
    await rm(linkPath, { force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('workspace apply patch restores earlier files when a later hunk fails', async () => {
  await writeFile(resolve(workspaceRoot, 'patch-atomic-a.txt'), 'alpha\n', 'utf8');
  await writeFile(resolve(workspaceRoot, 'patch-atomic-b.txt'), 'beta\n', 'utf8');

  await assert.rejects(
    gateway.applyWorkspacePatch({
      patch: [
        '*** Begin Patch',
        '*** Update File: patch-atomic-a.txt',
        '@@',
        '-alpha',
        '+changed',
        '*** Update File: patch-atomic-b.txt',
        '@@',
        '-missing',
        '+changed',
        '*** End Patch',
      ].join('\n'),
    }),
    /Patch hunk did not match/
  );

  assert.equal(await readFile(resolve(workspaceRoot, 'patch-atomic-a.txt'), 'utf8'), 'alpha\n');
  assert.equal(await readFile(resolve(workspaceRoot, 'patch-atomic-b.txt'), 'utf8'), 'beta\n');
});

test('workspace command fails closed when post-command file-change capture fails', async () => {
  const blockedPath = resolve(workspaceRoot, 'blocked-capture');

  try {
    await assert.rejects(
      gateway.runWorkspaceCommand({
        command: 'mkdir blocked-capture && chmod 000 blocked-capture',
        captureFileChanges: true,
      }),
      (error) =>
        error?.code === 'file_change_capture_failed' &&
        error?.status === 'failed' &&
        /capture file changes/.test(error.message)
    );
  } finally {
    await chmod(blockedPath, 0o700).catch(() => {});
    await rm(blockedPath, { recursive: true, force: true });
  }
});

test('workspace command strips gateway-owned secrets from child process env', async () => {
  process.env.LIFECYCLE_GATEWAY_TOKEN = 'gateway-secret';
  process.env.LIFECYCLE_SESSION_MCP_CONFIG_JSON = '[{"slug":"secret"}]';

  const result = await gateway.runWorkspaceCommand({
    command: 'printf "%s/%s" "${LIFECYCLE_GATEWAY_TOKEN-unset}" "${LIFECYCLE_SESSION_MCP_CONFIG_JSON-unset}"',
  });

  assert.equal(result.stdout, 'unset/unset');
});

test('workspace command strips denied tokens and runtime-control env from child process env', async () => {
  const original = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
  };
  process.env.GITHUB_TOKEN = 'ghp_secret';
  process.env.OPENAI_API_KEY = 'sk-secret';
  process.env.NODE_OPTIONS = '--require /tmp/intercept.js';
  process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';

  try {
    const result = await gateway.runWorkspaceCommand({
      command:
        'printf "%s/%s/%s/%s" "${GITHUB_TOKEN-unset}" "${OPENAI_API_KEY-unset}" "${NODE_OPTIONS-unset}" "${SSH_AUTH_SOCK-unset}"',
    });

    assert.equal(result.stdout, 'unset/unset/unset/unset');
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (typeof value === 'undefined') {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('workspace service remains running beyond the default command operation timeout', async () => {
  const started = await gateway.startWorkspaceService({
    name: 'preview-app',
    command: 'node -e "console.log(\'ready\'); setInterval(() => {}, 1000)"',
    port: 3000,
    waitMs: 300,
  });

  assert.equal(started.status, 'running');
  assert.equal(started.port, 3000);

  const ready = await gateway.waitForWorkspaceService('preview-app', {
    waitMs: 300,
    includeLogs: true,
  });
  assert.equal(ready.running, true);
  assert.match(ready.stdout, /ready/);

  await new Promise((resolveWait) => setTimeout(resolveWait, 2300));

  const status = await gateway.waitForWorkspaceService('preview-app', {
    includeLogs: true,
  });

  assert.equal(status.status, 'running');
  assert.equal(status.running, true);
  assert.match(status.stdout, /ready/);

  const stopped = await gateway.stopWorkspaceService('preview-app', {
    waitMs: 2000,
  });

  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.running, false);
  assert.equal(stopped.stopRequested, true);
});

test('workspace service name aliases normalize and reject conflicts', () => {
  assert.equal(gateway.resolveWorkspaceServiceName(), 'app');
  assert.equal(gateway.resolveWorkspaceServiceName({ name: 'preview-alias' }), 'preview-alias');
  assert.equal(
    gateway.resolveWorkspaceServiceName({
      serviceName: 'preview',
      name: 'preview',
    }),
    'preview'
  );
  assert.throws(
    () =>
      gateway.resolveWorkspaceServiceName({
        serviceName: 'preview',
        name: 'other-preview',
      }),
    /must match/
  );
});

test('workspace service start requires restart before replacing a running service', async () => {
  const first = await gateway.startWorkspaceService({
    name: 'restartable',
    command: 'node -e "console.log(\'first\'); setInterval(() => {}, 1000)"',
    waitMs: 300,
  });

  assert.equal(first.status, 'running');
  const firstStatus = await gateway.waitForWorkspaceService('restartable');
  await assert.rejects(
    gateway.startWorkspaceService({
      name: 'restartable',
      command: 'node -e "console.log(\'second\'); setInterval(() => {}, 1000)"',
    }),
    /already running/
  );

  const second = await gateway.startWorkspaceService({
    name: 'restartable',
    command: 'node -e "console.log(\'second\'); setInterval(() => {}, 1000)"',
    restart: true,
    waitMs: 300,
  });

  assert.equal(second.status, 'running');

  const secondStatus = await gateway.waitForWorkspaceService('restartable', {
    waitMs: 300,
    includeLogs: true,
  });
  assert.notEqual(secondStatus.serviceId, firstStatus.serviceId);
  assert.match(secondStatus.stdout, /second/);

  await gateway.stopWorkspaceService('restartable', {
    waitMs: 2000,
  });
});

test('workspace service stop terminates descendant processes', async () => {
  const leakPath = resolve(workspaceRoot, 'service-descendant-leak.txt');
  const started = await gateway.startWorkspaceService({
    name: 'descendant-cleanup',
    command: '(sleep 0.8; printf "leaked" > service-descendant-leak.txt) & wait',
    waitMs: 50,
  });

  assert.equal(started.status, 'running');

  const stopped = await gateway.stopWorkspaceService('descendant-cleanup', {
    waitMs: 2000,
  });

  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.running, false);
  assert.equal(stopped.stopRequested, true);
  await delay(1000);
  assert.equal(await fileExists(leakPath), false);
});

test('workspace service logs return bounded tails with truncation metadata', async () => {
  const started = await gateway.startWorkspaceService({
    name: 'chatty-service',
    command: 'node -e "process.stdout.write(\'S\'.repeat(120)); setInterval(() => {}, 1000)"',
    waitMs: 300,
  });

  assert.equal(started.status, 'running');

  const logs = gateway.readWorkspaceServiceLogs('chatty-service', {
    stream: 'stdout',
    maxChars: 12,
  });

  assert.equal(logs.truncated, true);
  assert.equal(logs.omittedChars, 108);
  assert.match(logs.text, /^\[truncated oldest 108 chars\]\nS{12}$/);

  await gateway.stopWorkspaceService('chatty-service', {
    waitMs: 2000,
  });
});

test('workspace service list can exclude stopped services', async () => {
  const started = await gateway.startWorkspaceService({
    name: 'listed-service',
    command: 'node -e "setInterval(() => {}, 1000)"',
    waitMs: 50,
  });

  assert.equal(started.status, 'running');

  await gateway.stopWorkspaceService('listed-service', {
    waitMs: 2000,
  });

  const runningOnly = gateway.listWorkspaceServices({
    includeStopped: false,
    limit: 100,
  });
  assert.equal(runningOnly.services.some((service) => service.name === 'listed-service'), false);

  const retained = gateway.listWorkspaceServices({
    includeStopped: true,
    limit: 100,
  });
  const listed = retained.services.find((service) => service.name === 'listed-service');
  assert.equal(listed?.status, 'stopped');
});
