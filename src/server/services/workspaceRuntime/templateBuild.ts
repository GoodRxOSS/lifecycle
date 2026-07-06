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

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import RedisClient from 'server/lib/redisClient';
import QueueManager from 'server/lib/queueManager';
import { redisClient } from 'server/lib/dependencies';
import { getLogger } from 'server/lib/logger';
import { BadRequestError, NotFoundError } from 'server/lib/appError';
import { QUEUE_NAMES } from 'shared/config';
import { resolveAgentSessionWorkspaceBackendConfig } from 'server/lib/agentSession/runtimeConfig';
import AgentSessionConfigService from '../agentSessionConfig';
import { getWorkspaceBackendDescriptor } from './registry';
import { collectSecretValues, scrubWorkspaceBackendSecrets } from './probeSafety';
import {
  appendTemplateBuildLogs,
  clearActiveTemplateBuild,
  getActiveTemplateBuild,
  getTemplateBuildState,
  isTemplateBuildTerminal,
  patchTemplateBuildState,
  setActiveTemplateBuild,
  setTemplateBuildState,
  type WorkspaceTemplateBuildState,
} from './templateBuildState';

export const DEFAULT_E2B_TEMPLATE_NAME = 'lifecycle-workspace';
// Pinned published workspace image (sysops/dockerfiles/agent.Dockerfile) used as the template base;
// gateway files + launcher are overlaid from this process's own filesystem so the template always
// matches the running API's gateway contract, not the image's release cadence.
export const DEFAULT_E2B_TEMPLATE_BASE_IMAGE = 'docker.io/lifecycleoss/workspace:v0.2.0';
const DEFAULT_TEMPLATE_CPU_COUNT = 2;
const DEFAULT_TEMPLATE_MEMORY_MB = 4096;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const TEMPLATE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const GATEWAY_SRC_DIR = 'sysops/workspace-gateway';
const GATEWAY_DEST_DIR = '/opt/lifecycle-workspace-gateway';
const GATEWAY_MODULE_FILES = [
  'index.mjs',
  'auth.mjs',
  'agentEnv.mjs',
  'schema.mjs',
  'skills-lib.mjs',
  'skills-bootstrap.mjs',
];
const LAUNCHER_SRC = 'scripts/e2b/e2b-launcher.sh';
const LAUNCHER_DEST = '/opt/lifecycle/e2b-launcher.sh';
// Contract with e2b-launcher.sh / providers/e2b.ts: launcher polls for the instance env dir.
const START_CMD = `sh ${LAUNCHER_DEST}`;
const READY_CMD = 'test -d /tmp/lifecycle';

type E2bSdk = typeof import('e2b');

let e2bSdkPromise: Promise<E2bSdk> | null = null;

function loadE2bSdk(): Promise<E2bSdk> {
  e2bSdkPromise ??= import('e2b');
  return e2bSdkPromise;
}

export interface WorkspaceTemplateBuildRequest {
  buildId: string;
  templateName: string;
  cpuCount: number;
  memoryMB: number;
}

export interface StartWorkspaceTemplateBuildInput {
  templateName?: unknown;
  cpuCount?: unknown;
  memoryMB?: unknown;
}

const templateBuildQueue = QueueManager.getInstance().registerQueue(QUEUE_NAMES.WORKSPACE_TEMPLATE_BUILD, {
  connection: redisClient.getConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false,
  },
});

function templateContextPath(): string {
  return process.cwd();
}

// Fails fast (in the POST request) when the API image is missing the overlay sources.
function assertTemplateContextFiles(): void {
  const contextPath = templateContextPath();
  const required = [
    path.join(GATEWAY_SRC_DIR, 'package.json'),
    ...GATEWAY_MODULE_FILES.map((file) => path.join(GATEWAY_SRC_DIR, file)),
    LAUNCHER_SRC,
  ];
  const missing = required.filter((file) => !fs.existsSync(path.join(contextPath, file)));
  if (missing.length) {
    throw new Error(`Template build context is missing required files under ${contextPath}: ${missing.join(', ')}`);
  }
}

function parsePositiveInt(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseTemplateName(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_E2B_TEMPLATE_NAME;
  }
  const name = String(value).trim().toLowerCase();
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    throw new BadRequestError(
      'Template name must be 1-64 characters of lowercase letters, digits, hyphens, or underscores.'
    );
  }
  return name;
}

export async function startWorkspaceTemplateBuild(
  id: string,
  input: StartWorkspaceTemplateBuildInput
): Promise<WorkspaceTemplateBuildState> {
  const descriptor = getWorkspaceBackendDescriptor(id);
  if (!descriptor) {
    throw new NotFoundError(`Unknown workspace backend: ${id}`, 'workspace_backend_not_found');
  }
  if (descriptor.id !== 'e2b') {
    throw new BadRequestError(
      `The ${descriptor.displayName} workspace backend does not support managed template builds.`
    );
  }

  const config = await resolveAgentSessionWorkspaceBackendConfig();
  if (!config.e2b?.apiKey) {
    throw new BadRequestError('E2B API key is not configured. Save an API key before building a template.');
  }

  const templateName = parseTemplateName(input.templateName);
  const cpuCount = parsePositiveInt(input.cpuCount, DEFAULT_TEMPLATE_CPU_COUNT, 1, 8, 'cpuCount');
  const memoryMB = parsePositiveInt(input.memoryMB, DEFAULT_TEMPLATE_MEMORY_MB, 512, 8192, 'memoryMB');
  assertTemplateContextFiles();

  const redis = RedisClient.getInstance().getRedis();
  const activeBuildId = await getActiveTemplateBuild(redis, descriptor.id);
  if (activeBuildId) {
    const active = await getTemplateBuildState(redis, activeBuildId);
    if (active && !isTemplateBuildTerminal(active)) {
      return active;
    }
  }

  const now = new Date().toISOString();
  const state: WorkspaceTemplateBuildState = {
    buildId: randomUUID(),
    backendId: descriptor.id,
    status: 'queued',
    stage: 'queued',
    message: 'Template build queued.',
    templateName,
    logs: [],
    templateId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await setTemplateBuildState(redis, state);
  await setActiveTemplateBuild(redis, descriptor.id, state.buildId);

  const request: WorkspaceTemplateBuildRequest = { buildId: state.buildId, templateName, cpuCount, memoryMB };
  await templateBuildQueue.add('build', request, { jobId: state.buildId });
  return state;
}

export async function getWorkspaceTemplateBuild(id: string, buildId: string): Promise<WorkspaceTemplateBuildState> {
  const descriptor = getWorkspaceBackendDescriptor(id);
  if (!descriptor) {
    throw new NotFoundError(`Unknown workspace backend: ${id}`, 'workspace_backend_not_found');
  }
  const redis = RedisClient.getInstance().getRedis();
  const state = await getTemplateBuildState(redis, (buildId || '').trim());
  if (!state || state.backendId !== descriptor.id) {
    throw new NotFoundError('Template build not found or expired.', 'workspace_template_build_not_found');
  }
  return state;
}

// Serialized, throttled log shipper: E2B emits bursts; one Redis write per flush window.
class TemplateBuildLogShipper {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly buildId: string, private readonly scrub: (line: string) => string) {}

  append(line: string): void {
    this.buffer.push(this.scrub(line));
    if (this.buffer.length >= 25) {
      this.scheduleFlush(0);
    } else {
      this.scheduleFlush(750);
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer) {
      if (delayMs > 0) {
        return;
      }
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  flush(): Promise<void> {
    const lines = this.buffer.splice(0);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (lines.length) {
      const redis = RedisClient.getInstance().getRedis();
      this.chain = this.chain
        .then(() => appendTemplateBuildLogs(redis, this.buildId, lines))
        .catch((error) => {
          getLogger().warn({ error }, 'Workspace template build: log append failed');
        });
    }
    return this.chain;
  }
}

export function composeE2bWorkspaceTemplate(sdk: E2bSdk, opts: { contextPath: string; baseImage: string }) {
  return (
    sdk
      .Template({ fileContextPath: opts.contextPath })
      .fromImage(opts.baseImage)
      // deps layer before module files so gateway-only changes reuse the npm cache
      .copy(`${GATEWAY_SRC_DIR}/package.json`, `${GATEWAY_DEST_DIR}/package.json`, { user: 'root' })
      .runCmd(`cd ${GATEWAY_DEST_DIR} && npm install --omit=dev`, { user: 'root' })
      .copy(
        GATEWAY_MODULE_FILES.map((file) => `${GATEWAY_SRC_DIR}/${file}`),
        `${GATEWAY_DEST_DIR}/`,
        { user: 'root' }
      )
      .copy(LAUNCHER_SRC, LAUNCHER_DEST, { user: 'root', mode: 0o755 })
      // E2B v2 runs the start command as the unprivileged `user`; pre-create writable paths.
      .runCmd(
        'mkdir -p /home/agent/.lifecycle-session /workspace' +
          ' && chown -R 1000:1000 /home/agent /workspace' +
          ' && chmod 0777 /home/agent /home/agent/.lifecycle-session /workspace',
        { user: 'root' }
      )
      .setStartCmd(START_CMD, READY_CMD)
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function runWorkspaceTemplateBuild(request: WorkspaceTemplateBuildRequest): Promise<void> {
  const redis = RedisClient.getInstance().getRedis();
  const { buildId, templateName, cpuCount, memoryMB } = request;
  let secrets: string[] = [];
  const scrubLine = (line: string) => scrubWorkspaceBackendSecrets(line, secrets);
  const logs = new TemplateBuildLogShipper(buildId, scrubLine);

  try {
    await patchTemplateBuildState(redis, buildId, {
      status: 'running',
      stage: 'preparing',
      message: 'Preparing template definition…',
    });

    const config = await resolveAgentSessionWorkspaceBackendConfig();
    const e2b = config.e2b;
    if (!e2b?.apiKey) {
      throw new Error('E2B API key is not configured.');
    }
    secrets = collectSecretValues(config);
    assertTemplateContextFiles();

    const sdk = await loadE2bSdk();
    const template = composeE2bWorkspaceTemplate(sdk, {
      contextPath: templateContextPath(),
      baseImage: DEFAULT_E2B_TEMPLATE_BASE_IMAGE,
    });

    await patchTemplateBuildState(redis, buildId, {
      stage: 'building',
      message: `Building template "${templateName}" on E2B (base ${DEFAULT_E2B_TEMPLATE_BASE_IMAGE})…`,
    });

    const info = await withTimeout(
      sdk.Template.build(template, templateName, {
        apiKey: e2b.apiKey,
        domain: e2b.domain,
        cpuCount,
        memoryMB,
        onBuildLogs: (entry) => logs.append(`[${entry.level}] ${entry.message}`),
      }),
      BUILD_TIMEOUT_MS,
      'E2B template build timed out after 30 minutes.'
    );
    await logs.flush();

    await patchTemplateBuildState(redis, buildId, {
      stage: 'configuring',
      message: 'Saving template to workspace settings…',
    });
    await AgentSessionConfigService.getInstance().setStoredE2bTemplateId(info.name);

    await patchTemplateBuildState(redis, buildId, {
      status: 'ready',
      stage: 'ready',
      templateId: info.templateId,
      message: `Template "${info.name}" is ready and selected for the E2B backend.`,
    });
  } catch (error) {
    await logs.flush();
    const message = scrubLine(error instanceof Error ? error.message : String(error));
    getLogger().error({ error, buildId }, 'Workspace template build failed');
    await patchTemplateBuildState(redis, buildId, {
      status: 'error',
      stage: 'error',
      error: message,
      message: `Template build failed: ${message}`,
    });
  } finally {
    await clearActiveTemplateBuild(redis, 'e2b');
  }
}
