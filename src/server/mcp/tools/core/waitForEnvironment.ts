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

import type { Principal } from 'server/lib/principal';
import Repository from 'server/models/Repository';
import BuildService from 'server/services/build';
import { getEnvironmentPhase, isEnvironmentTerminal } from 'server/lib/environments/readiness';
import { DEFAULT_MCP_WAIT_SECONDS, loadMcpRuntimeConfig, MAX_MCP_WAIT_SECONDS } from '../../config';
import type { McpJsonObject, McpToolDefinition } from '../../contracts';
import { McpExecutionError } from '../../errors';
import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';
import {
  conciseEnvironmentSchema,
  isEnvironmentBuild,
  serializeEnvironmentState,
  type EnvironmentRepositoryAnchor,
  type LoadedEnvironment,
} from './getEnvironment';
import { mapCoreToolError } from './listRepositories';

const DESCRIPTION =
  'Checks briefly whether an environment reached a goal. When an environment is returned, show its `lifecycleUiUrl` so the user can follow deployment status in Lifecycle. Use only when the user explicitly asks you to monitor now; ordinary mutation flows should report the acceptance receipt without calling this tool. Pass uuid and environmentId from a prior receipt or get_environment. After a deploy, also pass its deployId.';

const POLL_INTERVAL_MS = 2_500;
const DEFAULT_REPLICA_WAIT_CAPACITY = 32;
const DEFAULT_PRINCIPAL_WAIT_CAPACITY = 4;

export type EnvironmentWaitGoal = 'ready' | 'terminal' | 'torn_down';
export type EnvironmentWaitOutcome = 'still_running' | 'reached' | 'failed' | 'paused' | 'destroyed' | 'not_current';
type EnvironmentWaitTerminalOutcome = Exclude<EnvironmentWaitOutcome, 'still_running'>;
const ENVIRONMENT_WAIT_OUTCOMES: EnvironmentWaitOutcome[] = [
  'still_running',
  'reached',
  'failed',
  'paused',
  'destroyed',
  'not_current',
];

export type EnvironmentWaitLoadedTarget =
  | {
      kind: 'live';
      loaded: LoadedEnvironment;
    }
  | {
      kind: 'tombstone';
    };

export interface WaitCapacity {
  acquire(
    principalKey: string
  ): { acquired: true; release: () => void } | { acquired: false; reason: 'replica' | 'principal' };
}

class WaitCapacityRegistry implements WaitCapacity {
  private total = 0;
  private readonly byPrincipal = new Map<string, number>();

  constructor(
    private readonly totalLimit = DEFAULT_REPLICA_WAIT_CAPACITY,
    private readonly perPrincipalLimit = DEFAULT_PRINCIPAL_WAIT_CAPACITY
  ) {}

  acquire(
    principalKey: string
  ): { acquired: true; release: () => void } | { acquired: false; reason: 'replica' | 'principal' } {
    if (this.total >= this.totalLimit) return { acquired: false, reason: 'replica' };
    const principalCount = this.byPrincipal.get(principalKey) ?? 0;
    if (principalCount >= this.perPrincipalLimit) {
      return { acquired: false, reason: 'principal' };
    }
    this.total += 1;
    this.byPrincipal.set(principalKey, principalCount + 1);
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        this.total = Math.max(0, this.total - 1);
        const next = this.byPrincipal.get(principalKey)! - 1;
        if (next <= 0) this.byPrincipal.delete(principalKey);
        else this.byPrincipal.set(principalKey, next);
      },
    };
  }
}

const defaultWaitCapacity = new WaitCapacityRegistry();

export interface WaitForEnvironmentToolDependencies {
  loadTarget?: (uuid: string, environmentId: number) => Promise<EnvironmentWaitLoadedTarget>;
  getMaxWaitSeconds?: () => number;
  nowMilliseconds?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  capacity?: WaitCapacity;
}

const environmentIdSchema = { type: 'integer', minimum: 1 } as const;

const waitInputBase = closedObjectSchema(
  {
    uuid: { type: 'string', minLength: 1, maxLength: 63 },
    environmentId: environmentIdSchema,
    goal: {
      type: 'string',
      enum: ['ready', 'terminal', 'torn_down'],
      default: 'ready',
      description:
        'Use ready for recorded readiness after create or deploy, terminal for deployment orchestration completion, and torn_down for exact-name release after destroy.',
    },
    deployId: { type: 'string', minLength: 10, maxLength: 30 },
    timeoutSeconds: {
      type: 'integer',
      minimum: 5,
      maximum: MAX_MCP_WAIT_SECONDS,
      default: DEFAULT_MCP_WAIT_SECONDS,
    },
  },
  ['uuid', 'environmentId']
);

export const waitForEnvironmentInputSchema = {
  ...waitInputBase,
  if: {
    properties: { goal: { const: 'torn_down' } },
    required: ['goal'],
  },
  then: {
    properties: {
      deployId: false,
    },
  },
};

const targetSchema = closedObjectSchema(
  {
    uuid: { type: 'string', minLength: 1, maxLength: 63 },
    environmentId: environmentIdSchema,
  },
  ['uuid', 'environmentId']
);

const waitResultSchema = {
  ...closedObjectSchema(
    {
      outcome: { type: 'string', enum: ENVIRONMENT_WAIT_OUTCOMES },
      environment: conciseEnvironmentSchema,
      note: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    ['outcome', 'note']
  ),
  if: {
    properties: { outcome: { const: 'still_running' } },
    required: ['outcome'],
  },
  then: {
    properties: { environment: true },
    required: ['environment'],
  },
};

export const waitForEnvironmentOutputSchema = successObjectSchema(
  {
    target: targetSchema,
    result: waitResultSchema,
  },
  ['target', 'result']
);

function principalWaitKey(principal: Principal): string {
  return `user:${principal.userId ?? principal.actor}`;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('wait aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('wait aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function repositoryAnchor(
  rootRepositoryId: number | null,
  fallbackFullName: string
): Promise<EnvironmentRepositoryAnchor> {
  const repository =
    rootRepositoryId == null
      ? undefined
      : await Repository.query().findOne({ githubRepositoryId: rootRepositoryId }).whereNull('deletedAt');
  return {
    githubRepositoryId: rootRepositoryId,
    fullName: repository?.fullName ?? fallbackFullName,
  };
}

function createDefaultTargetLoader(): (uuid: string, environmentId: number) => Promise<EnvironmentWaitLoadedTarget> {
  const builds = new BuildService();
  return async (uuid, environmentId) => {
    const build = await builds.getBuildByUUID(uuid, {
      liveOnly: false,
      expectedBuildId: environmentId,
    });
    if (!build) {
      throw new McpExecutionError(
        'environment_replaced',
        'The environment you knew was destroyed or replaced. Re-read the environment before acting.',
        { details: { replacementExists: false } }
      );
    }
    if (build.deletedAt) {
      return { kind: 'tombstone' };
    }
    const repository = await repositoryAnchor(
      build.githubRepositoryId == null ? null : Number(build.githubRepositoryId),
      build.pullRequest?.fullName ?? ''
    );
    return {
      kind: 'live',
      loaded: {
        build,
        repository: {
          ...repository,
          fullName: repository.fullName || build.pullRequest?.fullName || '',
        },
      },
    };
  };
}

interface EvaluatedWait {
  outcome?: EnvironmentWaitTerminalOutcome;
  note?: string;
}

function evaluateWait(
  target: EnvironmentWaitLoadedTarget,
  goal: EnvironmentWaitGoal,
  deployId: string | undefined
): EvaluatedWait {
  if (target.kind === 'tombstone') {
    return {
      outcome: goal === 'torn_down' ? 'reached' : 'destroyed',
      note:
        goal === 'torn_down'
          ? 'Lifecycle released this exact environment name.'
          : 'This exact environment was destroyed.',
    };
  }

  const { build } = target.loaded;
  const phase = getEnvironmentPhase(build);
  if (deployId) {
    if (phase === 'tearing_down' || phase === 'torn_down') {
      return {
        outcome: 'destroyed',
        note: 'This exact environment is being or has been destroyed, so the deploy cannot finish.',
      };
    }
    if (build.runUUID !== deployId) {
      return {};
    }
  }

  if (phase === 'failed') {
    return {
      outcome: 'failed',
      note: 'The environment failed. Read its failing services or call diagnose_environment.',
    };
  }
  if (phase === 'paused') {
    return {
      outcome: 'paused',
      note: 'Enable deploys with configure_environment. If no deploy was queued, call deploy_environment when you want to start it.',
    };
  }
  if (goal !== 'torn_down' && (phase === 'tearing_down' || phase === 'torn_down')) {
    return {
      outcome: 'destroyed',
      note: 'This exact environment is being or has been destroyed.',
    };
  }
  if (goal === 'ready' && phase === 'ready') {
    return {
      outcome: 'reached',
      note: 'The environment reached recorded readiness.',
    };
  }
  if (goal === 'terminal' && isEnvironmentTerminal(build)) {
    return {
      outcome: 'reached',
      note:
        phase === 'deployed_not_ready'
          ? 'Deployment orchestration finished, but one or more services are not ready.'
          : 'Deployment orchestration finished.',
    };
  }
  return {};
}

function environmentForResult(target: EnvironmentWaitLoadedTarget): McpJsonObject | undefined {
  return target.kind === 'live' ? serializeEnvironmentState(target.loaded, { format: 'concise' }) : undefined;
}

function assertEnvironmentTarget(target: EnvironmentWaitLoadedTarget): void {
  if (target.kind === 'live' && !isEnvironmentBuild(target.loaded.build)) {
    throw new McpExecutionError('env_not_found', 'That environment was not found.');
  }
}

export function createWaitForEnvironmentToolDefinition(
  dependencies: WaitForEnvironmentToolDependencies = {}
): McpToolDefinition {
  const loadTarget = dependencies.loadTarget ?? createDefaultTargetLoader();
  const getMaxWaitSeconds = dependencies.getMaxWaitSeconds ?? (() => loadMcpRuntimeConfig().maxWaitSeconds);
  const nowMilliseconds = dependencies.nowMilliseconds ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const capacity = dependencies.capacity ?? defaultWaitCapacity;

  return {
    name: 'wait_for_environment',
    title: 'Wait for environment',
    description: DESCRIPTION,
    inputSchema: waitForEnvironmentInputSchema,
    outputSchema: waitForEnvironmentOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'understand-environments',
    access: 'read',
    async handler(input, context): Promise<McpJsonObject> {
      try {
        const uuid = input.uuid as string;
        const environmentId = input.environmentId as number;
        const goal = (input.goal as EnvironmentWaitGoal | undefined) ?? 'ready';
        const deployId = typeof input.deployId === 'string' ? input.deployId : undefined;
        const maxWaitSeconds = Math.max(5, Math.min(MAX_MCP_WAIT_SECONDS, getMaxWaitSeconds()));
        const requestedTimeout =
          typeof input.timeoutSeconds === 'number'
            ? input.timeoutSeconds
            : Math.min(DEFAULT_MCP_WAIT_SECONDS, maxWaitSeconds);
        const timeoutSeconds = Math.min(requestedTimeout, maxWaitSeconds);
        let current = await loadTarget(uuid, environmentId);
        assertEnvironmentTarget(current);

        const slot = capacity.acquire(principalWaitKey(context.principal));
        if (slot.acquired === false) {
          throw new McpExecutionError(
            'wait_capacity',
            slot.reason === 'principal'
              ? 'This caller already has too many active waits. Consolidate waits and retry.'
              : 'Lifecycle is handling its maximum number of waits right now. Retry shortly.',
            { retryAfterSeconds: 5 }
          );
        }

        try {
          const startedAt = nowMilliseconds();
          const deadline = startedAt + timeoutSeconds * 1000;
          for (;;) {
            const evaluated = evaluateWait(current, goal, deployId);
            if (evaluated.outcome) {
              const environment = environmentForResult(current);
              return {
                target: { uuid, environmentId },
                result: {
                  outcome: evaluated.outcome,
                  ...(environment ? { environment } : {}),
                  note: evaluated.note!,
                },
              };
            }

            const remaining = deadline - nowMilliseconds();
            if (remaining <= 0) break;
            await sleep(Math.min(POLL_INTERVAL_MS, remaining), context.signal);
            current = await loadTarget(uuid, environmentId);
            assertEnvironmentTarget(current);
          }

          const liveCurrent = current as Extract<EnvironmentWaitLoadedTarget, { kind: 'live' }>;
          const environment = serializeEnvironmentState(liveCurrent.loaded, { format: 'concise' });
          const phase = getEnvironmentPhase(liveCurrent.loaded.build);
          if (deployId && liveCurrent.loaded.build.runUUID !== deployId) {
            return {
              target: { uuid, environmentId },
              result: {
                outcome: 'not_current',
                environment,
                note: 'Lifecycle could not confirm the requested deploy as this environment’s current deploy.',
              },
            };
          }
          const observation =
            goal === 'torn_down'
              ? phase === 'torn_down'
                ? 'Lifecycle has not released this exact environment name yet.'
                : 'Teardown is still running.'
              : goal === 'terminal'
              ? 'Deployment orchestration is still running.'
              : 'The environment has not reached recorded readiness yet.';
          return {
            target: { uuid, environmentId },
            result: {
              outcome: 'still_running',
              environment,
              note: `${observation} Work continues in the background. Report this state without waiting again unless the user explicitly asks you to keep monitoring.`,
            },
          };
        } finally {
          slot.release();
        }
      } catch (error) {
        throw mapCoreToolError(error);
      }
    },
  };
}
