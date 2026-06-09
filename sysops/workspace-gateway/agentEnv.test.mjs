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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAgentCommandEnv, resolveDeniedAgentEnvNames } from './agentEnv.mjs';

test('strips the gateway-owned secrets from agent command env', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/node',
    LIFECYCLE_GATEWAY_TOKEN: 'deadbeef',
    LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[{"slug":"x"}]',
  };
  const result = buildAgentCommandEnv(env);
  assert.equal(result.LIFECYCLE_GATEWAY_TOKEN, undefined);
  assert.equal(result.LIFECYCLE_SESSION_MCP_CONFIG_JSON, undefined);
  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.HOME, '/home/node');
});

test('honors the operator denylist and drops the denylist var itself', () => {
  const env = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-secret',
    KEEP_ME: 'yes',
    LIFECYCLE_SHELL_DENIED_ENV: 'ANTHROPIC_API_KEY, OPENAI_API_KEY',
  };
  const denied = resolveDeniedAgentEnvNames(env);
  assert.ok(denied.has('ANTHROPIC_API_KEY'));
  assert.ok(denied.has('OPENAI_API_KEY'));
  assert.ok(denied.has('LIFECYCLE_SHELL_DENIED_ENV'));

  const result = buildAgentCommandEnv(env);
  assert.equal(result.ANTHROPIC_API_KEY, undefined);
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.LIFECYCLE_SHELL_DENIED_ENV, undefined);
  assert.equal(result.KEEP_ME, 'yes');
});

test('strips credential-shaped and runtime-control env vars by default', () => {
  const result = buildAgentCommandEnv({
    PATH: '/usr/bin',
    HOME: '/home/node',
    PORT: '3000',
    GITHUB_TOKEN: 'ghp_secret',
    OPENAI_API_KEY: 'sk-secret',
    DATABASE_PASSWORD: 'password',
    SESSION_SECRET: 'secret',
    LD_PRELOAD: '/tmp/intercept.so',
    DYLD_INSERT_LIBRARIES: '/tmp/intercept.dylib',
    NODE_OPTIONS: '--require /tmp/intercept.js',
    GIT_SSH_COMMAND: 'ssh -i /tmp/key',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    HTTPS_PROXY: 'http://proxy.example',
  });

  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.HOME, '/home/node');
  assert.equal(result.PORT, '3000');
  assert.equal(result.GITHUB_TOKEN, undefined);
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.DATABASE_PASSWORD, undefined);
  assert.equal(result.SESSION_SECRET, undefined);
  assert.equal(result.LD_PRELOAD, undefined);
  assert.equal(result.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(result.NODE_OPTIONS, undefined);
  assert.equal(result.GIT_SSH_COMMAND, undefined);
  assert.equal(result.SSH_AUTH_SOCK, undefined);
  assert.equal(result.HTTPS_PROXY, undefined);
});

test('applies an optional allowlist after default denials', () => {
  const result = buildAgentCommandEnv({
    PATH: '/usr/bin',
    HOME: '/home/node',
    PORT: '3000',
    DEBUG: '1',
    OPENAI_API_KEY: 'sk-secret',
    LIFECYCLE_SHELL_ALLOWED_ENV: 'PATH,PORT,OPENAI_API_KEY',
  });

  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.PORT, '3000');
  assert.equal(result.HOME, undefined);
  assert.equal(result.DEBUG, undefined);
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.LIFECYCLE_SHELL_ALLOWED_ENV, undefined);
});

test('applies overrides after stripping', () => {
  const result = buildAgentCommandEnv(
    { LIFECYCLE_GATEWAY_TOKEN: 'x', HOME: '' },
    { HOME: '/workspace', OPENAI_API_KEY: 'sk-secret' },
  );
  assert.equal(result.LIFECYCLE_GATEWAY_TOKEN, undefined);
  assert.equal(result.HOME, '/workspace');
  assert.equal(result.OPENAI_API_KEY, undefined);
});
