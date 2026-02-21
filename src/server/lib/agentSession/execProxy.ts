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

import * as k8s from '@kubernetes/client-node';
import { Writable, Readable } from 'stream';
import { getLogger } from 'server/lib/logger';
import { resolveAgentSessionClaudeConfig } from './runtimeConfig';

const logger = getLogger();
const CLAUDE_HOME = '/home/claude/.claude';

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildClaudeExecScript(model: string, appendSystemPrompt?: string): string {
  const nestedClaudeDir = `${CLAUDE_HOME}/.claude`;
  const legacySettingsPath = `${CLAUDE_HOME}/settings.json`;
  const settingsPath = `${nestedClaudeDir}/settings.json`;
  const appendSystemPromptFlag = appendSystemPrompt?.trim()
    ? ` --append-system-prompt ${shellEscape(appendSystemPrompt.trim())}`
    : '';

  return [
    `mkdir -p ${shellEscape(nestedClaudeDir)}`,
    `if [ -f ${shellEscape(legacySettingsPath)} ] && [ ! -f ${shellEscape(settingsPath)} ]; then cp ${shellEscape(
      legacySettingsPath
    )} ${shellEscape(settingsPath)}; fi`,
    `export HOME=${shellEscape(CLAUDE_HOME)}`,
    `exec claude -p --model ${shellEscape(
      model
    )} --output-format stream-json --input-format stream-json --permission-mode bypassPermissions${appendSystemPromptFlag} --verbose`,
  ].join('; ');
}

export interface ExecConnection {
  write(data: string): void;
  cancel(): void;
  close(): void;
  onStdout(handler: (data: string) => void): void;
  onStderr(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
}

async function sendSignalToClaudeProcess(
  namespace: string,
  podName: string,
  container: string,
  signal: string
): Promise<void> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const exec = new k8s.Exec(kc);

  const discard = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

  try {
    await exec.exec(
      namespace,
      podName,
      container,
      ['sh', '-c', `kill -${signal} $(pgrep -f "claude" | head -1) 2>/dev/null || true`],
      discard,
      discard,
      null,
      false
    );
  } catch (err: any) {
    logger.warn(`Failed to send ${signal} to claude process: pod=${podName} err=${err?.message}`);
  }
}

export async function attachToAgentPod(
  namespace: string,
  podName: string,
  model: string,
  container = 'agent'
): Promise<ExecConnection> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const exec = new k8s.Exec(kc);

  const stdoutHandlers: Array<(data: string) => void> = [];
  const stderrHandlers: Array<(data: string) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];

  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      const str = chunk.toString();
      stdoutHandlers.forEach((h) => h(str));
      callback();
    },
  });

  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      const str = chunk.toString();
      stderrHandlers.forEach((h) => h(str));
      callback();
    },
  });

  const stdin = new Readable({ read() {} });
  let closed = false;
  const claudeConfig = await resolveAgentSessionClaudeConfig();

  try {
    const ws = await exec.exec(
      namespace,
      podName,
      container,
      ['sh', '-lc', buildClaudeExecScript(model, claudeConfig.appendSystemPrompt)],
      stdout,
      stderr,
      stdin,
      false
    );
    if (ws && typeof ws.on === 'function') {
      ws.on('close', () => {
        if (!closed) {
          closed = true;
          closeHandlers.forEach((h) => h());
        }
      });
      ws.on('error', (err: Error) => {
        errorHandlers.forEach((h) => h(err));
      });
    }
  } catch (err: any) {
    logger.error(`Failed to exec into agent pod: name=${podName} err=${err?.message}`);
    throw err;
  }

  return {
    write(data: string) {
      if (!closed) stdin.push(data);
    },
    cancel() {
      if (!closed) {
        sendSignalToClaudeProcess(namespace, podName, container, 'INT');
      }
    },
    close() {
      if (!closed) {
        closed = true;
        stdin.push(null);
        closeHandlers.forEach((h) => h());
      }
    },
    onStdout(handler) {
      stdoutHandlers.push(handler);
    },
    onStderr(handler) {
      stderrHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    onError(handler) {
      errorHandlers.push(handler);
    },
  };
}
