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

// Secrets the gateway holds for its OWN use that an agent shell must never see — the agent
// never calls the gateway and never reads the in-pod MCP config, so these are stripped from
// every command the gateway runs on the agent's behalf (and from the env any dependency the
// agent spawns can read via `env` / /proc).
const GATEWAY_OWNED_SECRET_ENV = [
  'LIFECYCLE_GATEWAY_TOKEN',
  'LIFECYCLE_SESSION_MCP_CONFIG_JSON',
];

const DENYLIST_ENV = 'LIFECYCLE_SHELL_DENIED_ENV';
const ALLOWLIST_ENV = 'LIFECYCLE_SHELL_ALLOWED_ENV';
const DANGEROUS_AGENT_ENV = [
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'RUBYOPT',
  'BUNDLE_GEMFILE',
  'GIT_SSH_COMMAND',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
];
const DANGEROUS_AGENT_ENV_PREFIXES = ['DYLD_'];
const CREDENTIAL_ENV_PATTERN = /(^|_)(TOKEN|KEY|SECRET|PASSWORD)$/i;

function parseEnvNameList(value = '') {
  return String(value)
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
}

function isDeniedByDefault(name) {
  const upperName = name.toUpperCase();
  return (
    DANGEROUS_AGENT_ENV.includes(upperName) ||
    DANGEROUS_AGENT_ENV_PREFIXES.some(prefix => upperName.startsWith(prefix)) ||
    CREDENTIAL_ENV_PATTERN.test(name)
  );
}

/** Resolve the full set of env var names to withhold from agent commands. */
export function resolveDeniedAgentEnvNames(env = process.env) {
  const configured = parseEnvNameList(env[DENYLIST_ENV]);
  const denied = new Set([
    ...GATEWAY_OWNED_SECRET_ENV,
    ...DANGEROUS_AGENT_ENV,
    ...configured,
    DENYLIST_ENV,
    ALLOWLIST_ENV,
  ]);

  for (const name of Object.keys(env)) {
    if (isDeniedByDefault(name)) {
      denied.add(name);
    }
  }

  return denied;
}

/** Build the environment for an agent-run command: the workspace env minus platform secrets. */
export function buildAgentCommandEnv(env = process.env, overrides = {}) {
  const merged = { ...env, ...overrides };
  const denied = resolveDeniedAgentEnvNames(merged);
  const allowed = new Set(parseEnvNameList(merged[ALLOWLIST_ENV]));
  const useAllowlist = allowed.size > 0;
  const result = {};
  for (const [name, value] of Object.entries(merged)) {
    if (denied.has(name) || (useAllowlist && !allowed.has(name))) {
      continue;
    }
    result[name] = value;
  }
  return result;
}
