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

import { BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
import { toMcpEnvironmentDto } from '../tools/core/environmentDto';

const SECRET = 'mcp-dto-super-secret-value-4f7e2a';
const LIFECYCLE_UI_BASE_URL = 'https://lifecycle.example.test/app';

function deploy(
  name: string,
  options: {
    type?: string;
    status?: DeployStatus;
    statusMessage?: string | null;
    updatedAt?: string;
    active?: boolean;
  } = {}
) {
  return {
    id: 100,
    buildId: 10,
    uuid: `deploy-${name}`,
    active: options.active ?? true,
    status: options.status ?? DeployStatus.READY,
    statusMessage: options.statusMessage ?? null,
    updatedAt: options.updatedAt ?? '2026-07-25T00:00:00.000Z',
    publicUrl: `${name}.example`,
    publicHref: `https://${name}.example`,
    branchName: 'main',
    sha: 'a'.repeat(40),
    dockerImage: `registry.example/${name}:latest`,
    buildLogs: `never-return-${SECRET}`,
    env: { LEAK: SECRET },
    initEnv: { LEAK: SECRET },
    deployable: {
      id: 200,
      name,
      type: options.type ?? DeployTypes.DOCKER,
      deploymentDependsOn: ['database'],
      manifest: `never-return-${SECRET}`,
    },
    repository: {
      id: 300,
      accessToken: SECRET,
      fullName: 'org/private-service',
    },
  } as any;
}

function build(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    uuid: 'safe-env-123456',
    status: BuildStatus.DEPLOYED,
    statusMessage: `old nonfailure detail ${SECRET}`,
    namespace: 'env-safe-env-123456',
    manifest: `never-return-${SECRET}`,
    branchName: 'main',
    triggerType: 'api',
    isStatic: false,
    deployEnabled: true,
    autoTrack: false,
    trackDefaultBranches: true,
    expiresAt: '2026-07-28T00:00:00.000Z',
    configSha: 'b'.repeat(40),
    runUUID: 'V1StGXR8_Z5jdHi6abcde',
    createdByUserId: 'internal-user-id-never-return',
    createdByGithubLogin: 'safe-author',
    commentRuntimeEnv: { API_TOKEN: SECRET },
    commentInitEnv: { DATABASE_PASSWORD: SECRET },
    deploys: [deploy('web')],
    ...overrides,
  } as any;
}

describe('MCP environment DTO', () => {
  const originalLifecycleUiUrl = process.env.LIFECYCLE_UI_URL;

  beforeAll(() => {
    process.env.LIFECYCLE_UI_URL = LIFECYCLE_UI_BASE_URL;
  });

  afterAll(() => {
    if (originalLifecycleUiUrl === undefined) delete process.env.LIFECYCLE_UI_URL;
    else process.env.LIFECYCLE_UI_URL = originalLifecycleUiUrl;
  });

  it('uses an allowlist and never returns stored env/initEnv values or internal/provider fields', () => {
    const dto = toMcpEnvironmentDto(build(), {
      repository: 'org/root',
      format: 'detailed',
    });
    const serialized = JSON.stringify(dto);

    expect(dto).toMatchObject({
      format: 'detailed',
      uuid: 'safe-env-123456',
      environmentId: 10,
      lifecycleUiUrl: `${LIFECYCLE_UI_BASE_URL}/environments/safe-env-123456`,
      currentDeployId: 'V1StGXR8_Z5jdHi6abcde',
      envKeys: ['API_TOKEN'],
      initEnvKeys: ['DATABASE_PASSWORD'],
      createdBy: 'safe-author',
    });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('internal-user-id-never-return');
    expect(serialized).not.toContain('buildLogs');
    expect(serialized).not.toContain('manifest');
    expect(serialized).not.toContain('accessToken');
    expect(serialized).not.toContain('"id"');
    expect(dto).not.toHaveProperty('statusMessage');
    expect(dto.services[0]).not.toHaveProperty('statusMessage');
  });

  it('sorts and clamps detailed env key names to 100 while omitting every value', () => {
    const runtimeEnv = Object.fromEntries(
      Array.from({ length: 125 }, (_, index) => [`KEY_${String(124 - index).padStart(3, '0')}`, `${SECRET}-${index}`])
    );
    const initEnv = Object.fromEntries(
      Array.from({ length: 110 }, (_, index) => [`INIT_${String(109 - index).padStart(3, '0')}`, `${SECRET}-${index}`])
    );

    const dto = toMcpEnvironmentDto(
      build({
        commentRuntimeEnv: runtimeEnv,
        commentInitEnv: initEnv,
      }),
      { repository: 'org/root', format: 'detailed' }
    );

    expect(dto.envKeys).toHaveLength(100);
    expect(dto.initEnvKeys).toHaveLength(100);
    expect(dto.envKeys).toEqual([...dto.envKeys!].sort());
    expect(dto.initEnvKeys).toEqual([...dto.initEnvKeys!].sort());
    expect(JSON.stringify(dto)).not.toContain(SECRET);
  });

  it('redacts failure text and bounds services failure-first then recent-first', () => {
    const dto = toMcpEnvironmentDto(
      build({
        status: BuildStatus.ERROR,
        statusMessage: `API_KEY=${SECRET}`,
        deploys: [
          deploy('older-ready', { updatedAt: '2026-07-20T00:00:00.000Z' }),
          deploy('newer-ready', { updatedAt: '2026-07-24T00:00:00.000Z' }),
          deploy('failed', {
            status: DeployStatus.DEPLOY_FAILED,
            statusMessage: `password=${SECRET}`,
            updatedAt: '2026-07-19T00:00:00.000Z',
          }),
        ],
      }),
      { repository: 'org/root', format: 'detailed', maxServices: 2 }
    );
    const serialized = JSON.stringify(dto);

    expect(dto.phase).toBe('failed');
    expect(dto.services.map((service) => service.name)).toEqual(['failed', 'newer-ready']);
    expect(dto.servicesTruncated).toBe(true);
    expect(dto.failingServices).toEqual(['failed']);
    expect(dto).toHaveProperty('statusMessage');
    expect(dto.services[0]).toHaveProperty('statusMessage');
    expect(serialized).not.toContain(SECRET);
  });

  it('normalizes a Date-backed environment expiry to RFC 3339', () => {
    const expiresAt = new Date('2026-07-28T00:00:00.000Z');
    const dateBackedBuild = build({ expiresAt });

    expect(
      toMcpEnvironmentDto(dateBackedBuild, {
        repository: 'org/root',
        format: 'detailed',
      })
    ).toMatchObject({
      expiresAt: expiresAt.toISOString(),
    });
  });

  it('emits a minimal concise PR shape while omitting every unavailable optional field', () => {
    const minimal = build({
      status: BuildStatus.ERROR,
      statusMessage: '   ',
      branchName: null,
      triggerType: 'github_pr',
      isStatic: true,
      deployEnabled: true,
      autoTrack: null,
      expiresAt: null,
      runUUID: null,
      configSha: null,
      trackDefaultBranches: false,
      createdByGithubLogin: null,
      commentRuntimeEnv: null,
      commentInitEnv: null,
      pullRequest: {
        branchName: 'feature/minimal',
        deployOnUpdate: false,
        githubLogin: 'pr-author',
        pullRequestNumber: 42,
        title: 'Minimal PR',
        status: 'open',
      },
      deploys: [
        {
          active: true,
          status: DeployStatus.ERROR,
          statusMessage: '   ',
          updatedAt: null,
          publicUrl: null,
          publicHref: null,
          branchName: null,
          sha: null,
          dockerImage: null,
          deployable: {
            name: 'mystery',
            type: null,
            deploymentDependsOn: [''],
          },
        },
        {
          active: true,
          status: DeployStatus.READY,
          updatedAt: null,
          deployable: { name: '', type: DeployTypes.DOCKER },
        },
      ],
    });

    const concise = toMcpEnvironmentDto(minimal, {
      repository: 'org/root',
      maxServices: 0,
    });
    const detailed = toMcpEnvironmentDto(minimal, {
      repository: 'org/root',
      format: 'detailed',
      maxServices: 500,
    });
    expect(concise).toMatchObject({
      format: 'concise',
      trigger: 'github_pr',
      branch: 'feature/minimal',
      isStatic: true,
      deployEnabled: false,
      services: [
        {
          name: 'mystery',
          type: 'unknown',
          active: true,
          status: DeployStatus.ERROR,
        },
      ],
    });
    expect(concise.environmentId).toBe(10);
    expect(concise).not.toHaveProperty('statusMessage');
    expect(concise).not.toHaveProperty('expiresAt');
    expect(concise).not.toHaveProperty('currentDeployId');
    expect(concise.services[0]).not.toHaveProperty('url');
    expect(concise.services[0]).not.toHaveProperty('branch');
    expect(detailed).toMatchObject({
      envKeys: [],
      initEnvKeys: [],
      trackDefaultBranches: false,
    });
    expect(detailed).not.toHaveProperty('configSha');
    expect(detailed).not.toHaveProperty('createdBy');
  });

  it('orders equal-recency nonfailures alphabetically and clamps external labels', () => {
    const publicUrlFallback = deploy('fallback-url', {
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    publicUrlFallback.publicHref = ' ';
    publicUrlFallback.deployable.deploymentDependsOn = undefined;
    const dto = toMcpEnvironmentDto(
      build({
        branchName: 'b'.repeat(300),
        deploys: [
          deploy('zeta', { updatedAt: '2026-07-20T00:00:00.000Z' }),
          deploy('alpha', { updatedAt: '2026-07-20T00:00:00.000Z' }),
          publicUrlFallback,
          {
            active: true,
            status: DeployStatus.READY,
            updatedAt: null,
            deployable: null,
          },
        ],
      }),
      {
        repository: 'r'.repeat(200),
      }
    );

    expect(dto.services.map((service) => service.name)).toEqual(['alpha', 'zeta', 'fallback-url']);
    expect(dto.services[2].url).toBe('fallback-url.example');
    expect(dto.repository).toHaveLength(140);
    expect(dto.branch).toHaveLength(255);

    const missingTimestamp = deploy('missing-timestamp');
    missingTimestamp.updatedAt = null;
    const presentTimestamp = deploy('present-timestamp', {
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(
      toMcpEnvironmentDto(build({ deploys: [missingTimestamp, presentTimestamp] }), {
        repository: 'org/root',
      }).services.map((service) => service.name)
    ).toEqual(['present-timestamp', 'missing-timestamp']);
    expect(
      toMcpEnvironmentDto(build({ deploys: [presentTimestamp, missingTimestamp] }), {
        repository: 'org/root',
      }).services.map((service) => service.name)
    ).toEqual(['present-timestamp', 'missing-timestamp']);
  });

  it('orders Date-backed deploy timestamps by recency', () => {
    const older = deploy('older');
    const newer = deploy('newer');
    older.updatedAt = new Date('2026-01-31T00:00:00.000Z');
    newer.updatedAt = new Date('2026-12-01T00:00:00.000Z');

    expect(
      toMcpEnvironmentDto(build({ deploys: [older, newer] }), {
        repository: 'org/root',
      }).services.map((service) => service.name)
    ).toEqual(['newer', 'older']);
  });

  it('handles missing deploy collections without widening the DTO', () => {
    const noDeploys = build({
      status: BuildStatus.QUEUED,
      statusMessage: null,
      deploys: null,
      createdByGithubLogin: null,
      pullRequest: null,
      expiresAt: null,
      runUUID: null,
    });

    const environment = toMcpEnvironmentDto(noDeploys, {
      repository: 'org/root',
    });
    expect(environment.services).toEqual([]);
    expect(environment.failingServices).toEqual([]);
  });

  it('normalizes nullable legacy PR source fields', () => {
    const environment = toMcpEnvironmentDto(
      build({
        branchName: 'legacy-feature',
        pullRequest: {
          branchName: null,
          deployOnUpdate: null,
        },
      }),
      { repository: 'org/root' }
    );

    expect(environment.branch).toBe('legacy-feature');
    expect(environment.deployEnabled).toBe(false);
  });
});
