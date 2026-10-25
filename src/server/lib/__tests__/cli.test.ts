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

const mockExecute = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockProcessSecretRefs = jest.fn();
const mockWaitForSecretSync = jest.fn();
const mockReadNamespacedSecret = jest.fn();
const mockDeleteNamespacedSecret = jest.fn();
const mockDeleteExternalSecret = jest.fn();
const mockCreateOrUpdateNamespace = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();
const mockUpdateLogContext = jest.fn();
const mockWithLogContext = jest.fn((_ctx, fn) => fn());
const mockDeployQuery = jest.fn();

jest.mock('server/lib/shell', () => ({
  redactCommandOutput: jest.requireActual('server/lib/shell').redactCommandOutput,
  shellPromise: (...args: any[]) => mockExecute(...args),
  execFilePromise: (...args: any[]) => mockExecute(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    debug: mockLoggerDebug,
    error: mockLoggerError,
    info: mockLoggerInfo,
    warn: jest.fn(),
  })),
  updateLogContext: (...args: any[]) => mockUpdateLogContext(...args),
  withLogContext: (...args: any[]) => mockWithLogContext(...args),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
    })),
  },
}));

jest.mock('server/services/secretProcessor', () => ({
  SecretProcessor: jest.fn().mockImplementation(() => ({
    processSecretRefs: (...args: any[]) => mockProcessSecretRefs(...args),
    waitForSecretSync: (...args: any[]) => mockWaitForSecretSync(...args),
  })),
}));

jest.mock('@kubernetes/client-node', () => ({
  CoreV1Api: jest.fn(),
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(() => ({
      readNamespacedSecret: (...args: any[]) => mockReadNamespacedSecret(...args),
      deleteNamespacedSecret: (...args: any[]) => mockDeleteNamespacedSecret(...args),
    })),
  })),
}));

jest.mock('server/lib/kubernetes/externalSecret', () => ({
  deleteExternalSecret: (...args: any[]) => mockDeleteExternalSecret(...args),
}));

jest.mock('server/lib/kubernetes', () => ({
  createOrUpdateNamespace: (...args: any[]) => mockCreateOrUpdateNamespace(...args),
}));

jest.mock('server/models', () => ({
  Deploy: {
    query: () => mockDeployQuery(),
  },
}));
import { DeployTypes } from 'shared/constants';
import {
  cliDeploy,
  codefreshDeploy,
  codefreshDestroy,
  deleteBuild,
  deleteDeploy,
  deployBuild,
  isPinnedCname,
  waitForCodefresh,
} from '../cli';

const secretProviders = {
  aws: {
    enabled: true,
    clusterSecretStore: 'aws-secrets',
    refreshInterval: '1h',
    allowedPrefixes: ['repo/example/'],
  },
};

function encoded(value: string) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function createDeploy(overrides: any = {}) {
  const patch = jest.fn().mockResolvedValue(undefined);
  return {
    uuid: 'deploy-uuid',
    branchName: 'feature-branch',
    env: {
      API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
    },
    build: {
      uuid: 'build-uuid',
      sha: 'build-sha',
      namespace: 'env-build-uuid',
      commentRuntimeEnv: {},
    },
    deployable: {
      name: 'example-service',
      deployPipelineId: 'deployable/deploy',
      deployTrigger: 'deployable-trigger',
      destroyPipelineId: 'deployable/destroy',
      destroyTrigger: 'deployable-destroy-trigger',
      branchName: 'deployable-branch',
    },
    $query: jest.fn(() => ({ patch })),
    ...overrides,
  } as any;
}

describe('codefresh cli external secret resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeployQuery.mockReset();
    mockExecute.mockResolvedValue('codefresh-run-id\n');
    mockGetAllConfigs.mockResolvedValue({ secretProviders });
    mockProcessSecretRefs.mockImplementation(({ secretRefs }) => ({
      secretRefs,
      expectedKeysPerSecret: { 'lfc-example-service-aws': secretRefs.map((ref: any) => ref.envKey) },
      syncTokensPerSecret: { 'lfc-example-service-aws': 'sync-token' },
      warnings: [],
    }));
    mockWaitForSecretSync.mockResolvedValue(undefined);
    mockCreateOrUpdateNamespace.mockResolvedValue(undefined);
    mockDeleteExternalSecret.mockResolvedValue(undefined);
    mockDeleteNamespacedSecret.mockResolvedValue(undefined);
    mockReadNamespacedSecret.mockResolvedValue({
      body: {
        data: {
          API_TOKEN: encoded('resolved-token'),
          CONFIG__credentials__token: encoded('nested-token'),
        },
      },
    });
  });

  test('resolves deploy env secret refs before invoking Codefresh and redacts debug command', async () => {
    const deploy = createDeploy();

    await expect(codefreshDeploy(deploy, deploy.build, deploy.deployable)).resolves.toBe('codefresh-run-id');

    const [file, command, options] = mockExecute.mock.calls[0];
    expect(file).toBe('codefresh');
    expect(command).toContain('--variable=API_TOKEN=resolved-token');
    expect(mockCreateOrUpdateNamespace).toHaveBeenCalledWith({
      name: 'env-build-uuid',
      buildUUID: 'build-uuid',
      staticEnv: false,
      waitForReady: true,
    });
    expect(options.redactCommand).toContain("'--variable=API_TOKEN=[REDACTED]'");
    expect(options.redactCommand).not.toContain('resolved-token');
    expect(mockLoggerDebug.mock.calls.map(([message]) => message).join('\n')).not.toContain('resolved-token');
  });

  test('passes resolved secret values as one literal Codefresh argument', async () => {
    mockReadNamespacedSecret.mockResolvedValue({
      body: {
        data: {
          API_TOKEN: encoded("resolved'token $(echo bad)"),
        },
      },
    });
    const deploy = createDeploy();

    await codefreshDeploy(deploy, deploy.build, deploy.deployable);

    const [file, command, options] = mockExecute.mock.calls[0];
    expect(file).toBe('codefresh');
    expect(command).toContain("--variable=API_TOKEN=resolved'token $(echo bad)");
    expect(options.redactCommand).toContain("'--variable=API_TOKEN=[REDACTED]'");
  });

  test('uses an immutable source ref for Codefresh while preserving the branch default', async () => {
    const deploy = createDeploy({ env: { API_URL: 'https://example.invalid' } });

    await codefreshDeploy(deploy, deploy.build, deploy.deployable, 'immutable-sha');
    expect(mockExecute.mock.calls[0][1][2]).toEqual('--branch=immutable-sha');

    mockExecute.mockClear();
    await codefreshDeploy(deploy, deploy.build, deploy.deployable);
    expect(mockExecute.mock.calls[0][1][2]).toEqual('--branch=feature-branch');
  });

  test('passes deploy and destroy triggers as one literal argument', async () => {
    const trigger = "deploy' $(id); --extra\nnext";
    const deploy = createDeploy({
      env: { API_URL: 'https://example.invalid' },
      deployable: { ...createDeploy().deployable, deployTrigger: trigger, destroyTrigger: trigger },
    });
    await codefreshDeploy(deploy, deploy.build, deploy.deployable);
    await codefreshDestroy(deploy);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    for (const [file, args] of mockExecute.mock.calls) {
      expect(file).toBe('codefresh');
      expect(args.slice(-2)).toEqual([`--trigger=${trigger}`, '-d']);
    }
  });

  test('redacts an echoed secret from debug output while preserving returned stdout', async () => {
    const deploy = createDeploy();
    mockExecute.mockResolvedValueOnce('resolved-token\n');
    await expect(codefreshDeploy(deploy, deploy.build, deploy.deployable)).resolves.toBe('resolved-token');
    expect(mockExecute.mock.calls[0][2].redactValues).toContain('resolved-token');
    expect(mockLoggerDebug.mock.calls.map(([message]) => message).join('\n')).not.toContain('resolved-token');
  });

  test('resolves destroy env secret refs before invoking Codefresh and cleans up synced resources', async () => {
    const deploy = createDeploy({
      env: {},
      build: {
        uuid: 'build-uuid',
        sha: 'build-sha',
        namespace: 'env-build-uuid',
        commentRuntimeEnv: {
          API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
        },
      },
    });

    await expect(codefreshDestroy(deploy)).resolves.toBe('codefresh-run-id');

    const [file, command, options] = mockExecute.mock.calls[0];
    expect(file).toBe('codefresh');
    expect(command.slice(0, 3)).toEqual(['run', 'deployable/destroy', '--branch=deployable-branch']);
    expect(command).toContain('--variable=BUILD_UUID=build-uuid');
    expect(command).toContain('--variable=API_TOKEN=resolved-token');
    expect(options.redactCommand).toContain("'--variable=API_TOKEN=[REDACTED]'");
    expect(mockDeleteExternalSecret).toHaveBeenCalledWith('example-service-aws-secrets', 'env-build-uuid');
    expect(mockDeleteNamespacedSecret).toHaveBeenCalledWith('example-service-aws-secrets', 'env-build-uuid');
  });

  test('cleans up synced resources when Codefresh destroy fails', async () => {
    mockExecute.mockRejectedValueOnce(new Error('destroy failed'));
    const deploy = createDeploy({
      env: {},
      build: {
        uuid: 'build-uuid',
        sha: 'build-sha',
        namespace: 'env-build-uuid',
        commentRuntimeEnv: {
          API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
        },
      },
    });

    await expect(codefreshDestroy(deploy)).rejects.toThrow('destroy failed');

    expect(mockDeleteExternalSecret).toHaveBeenCalledWith('example-service-aws-secrets', 'env-build-uuid');
    expect(mockDeleteNamespacedSecret).toHaveBeenCalledWith('example-service-aws-secrets', 'env-build-uuid');
  });

  test('resolves nested object env refs and preserves JSON stringification for Codefresh variables', async () => {
    const deploy = createDeploy({
      env: {
        CONFIG: {
          credentials: {
            token: '{{aws:repo/example/service:API_TOKEN}}',
          },
          mode: 'test',
        },
      },
    });

    await codefreshDeploy(deploy, deploy.build, deploy.deployable);

    const [file, command, options] = mockExecute.mock.calls[0];
    expect(file).toBe('codefresh');
    expect(command).toContain(
      `--variable=CONFIG=${JSON.stringify({ credentials: { token: 'nested-token' }, mode: 'test' })}`
    );
    expect(options.redactCommand).toContain("'--variable=CONFIG=[REDACTED]'");
  });

  test('preserves no-secret behavior without loading secret provider config', async () => {
    const deploy = createDeploy({
      env: {
        API_URL: 'https://example.invalid',
      },
    });

    await codefreshDeploy(deploy, deploy.build, deploy.deployable);

    expect(mockGetAllConfigs).not.toHaveBeenCalled();
    expect(mockProcessSecretRefs).not.toHaveBeenCalled();
    expect(mockExecute.mock.calls[0][1]).toContain('--variable=API_URL=https://example.invalid');
  });

  test('fails before invoking Codefresh when a secret provider is missing', async () => {
    mockGetAllConfigs.mockResolvedValue({ secretProviders: undefined });
    const deploy = createDeploy();

    await expect(codefreshDeploy(deploy, deploy.build, deploy.deployable)).rejects.toThrow(
      'external secret providers are not configured'
    );

    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('propagates CLI teardown failures so the owning delete worker can retry', async () => {
    mockDeployQuery.mockImplementation(() => {
      throw new Error('deploy query failed');
    });

    await expect(deleteBuild({ id: 7, uuid: 'build-uuid' } as any)).rejects.toThrow('deploy query failed');
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe('CLI build cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeployQuery.mockReset();
  });

  test('does not eager-load the removed Deploy.service relation', async () => {
    const withGraphFetched = jest.fn().mockResolvedValue([]);
    const where = jest.fn(() => ({ withGraphFetched }));
    mockDeployQuery.mockReturnValue({ where });

    await deleteBuild({ id: 42, uuid: 'build-uuid' } as any);

    expect(withGraphFetched).toHaveBeenCalledWith({ build: true, deployable: true });
    expect(withGraphFetched.mock.calls[0][0]).not.toHaveProperty('service');
  });
});

describe('generic CLI deploy lifecycle', () => {
  const databaseSettings = {
    auroraRestoreSettings: {
      region: 'us-east-1',
      sourceCluster: 'source-aurora',
    },
    rdsRestoreSettings: {
      region: 'us-west-2',
      sourceInstance: 'source-rds',
    },
  };

  function createCliDeploy(type: DeployTypes = DeployTypes.AURORA_RESTORE, overrides: Record<string, unknown> = {}) {
    return {
      uuid: `${type}-deploy-uuid`,
      active: true,
      env: {},
      build: {
        uuid: 'build-uuid',
        sha: 'build-sha',
        namespace: 'env-build-uuid',
        commentRuntimeEnv: {},
      },
      deployable: {
        type,
        name: `${type}-service`,
        command: type === DeployTypes.AURORA_RESTORE ? 'scripts/aurora-helper.ts' : 'scripts/docker-helper.ts',
        arguments: '--restore latest',
      },
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeployQuery.mockReset();
    mockExecute.mockReset().mockResolvedValue('command-output');
    mockGetAllConfigs.mockReset().mockResolvedValue(databaseSettings);
  });

  test('deployBuild invokes only CLI-backed deploys with per-service log context', async () => {
    const cli = createCliDeploy();
    const nonCli = createCliDeploy(DeployTypes.DOCKER);

    await deployBuild({ deploys: [cli, nonCli] } as any);

    expect(cli.$fetchGraph).toHaveBeenCalledWith('[build, deployable]');
    expect(nonCli.$fetchGraph).not.toHaveBeenCalled();
    expect(mockWithLogContext).toHaveBeenCalledWith(
      { deployUuid: 'aurora-restore-deploy-uuid', serviceName: 'aurora-restore-service' },
      expect.any(Function)
    );
    expect(mockExecute).toHaveBeenCalledWith(
      `AWS_REGION=us-east-1 pnpm run babel-node -- scripts/aurora-helper.ts deploy --stackName build-uuid-build-sha --serviceName aurora-restore-service --buildUUID build-uuid --restore latest --settings '${JSON.stringify(
        databaseSettings.auroraRestoreSettings
      )}'`
    );
  });

  test('cliDeploy fetches relations and propagates shell failures', async () => {
    const failure = new Error('helper failed');
    const deploy = createCliDeploy();
    mockExecute.mockRejectedValueOnce(failure);

    await expect(cliDeploy(deploy)).rejects.toBe(failure);

    expect(deploy.$fetchGraph).toHaveBeenCalledWith('[build, deployable]');
  });

  test('deleteDeploy selects RDS settings and builds the destroy context', async () => {
    const deploy = createCliDeploy(DeployTypes.AURORA_RESTORE, {
      deployable: {
        type: DeployTypes.AURORA_RESTORE,
        name: 'rds-service',
        command: 'scripts/rds-helper.ts',
        arguments: '--snapshot latest',
      },
    });

    await deleteDeploy(deploy);

    expect(mockExecute).toHaveBeenCalledWith(
      `AWS_REGION=us-west-2 pnpm run babel-node -- scripts/rds-helper.ts destroy --stackName build-uuid-build-sha --serviceName rds-service --buildUUID build-uuid --snapshot latest --settings '${JSON.stringify(
        databaseSettings.rdsRestoreSettings
      )}'`
    );
  });

  test.each([
    ['success', true],
    ['failed', false],
    [undefined, undefined],
  ])('waitForCodefresh maps status %p to %p', async (status, expected) => {
    mockExecute.mockResolvedValueOnce(undefined).mockResolvedValueOnce(status);

    await expect(waitForCodefresh('codefresh-id')).resolves.toBe(expected);

    expect(mockExecute).toHaveBeenNthCalledWith(1, 'codefresh wait -t 60 codefresh-id');
    expect(mockExecute).toHaveBeenNthCalledWith(2, 'codefresh get build codefresh-id --output json | jq -r ".status"');
  });

  test('waitForCodefresh translates CLI failures into the public pipeline error', async () => {
    mockExecute.mockRejectedValueOnce(new Error('timed out'));

    await expect(waitForCodefresh('codefresh-id')).rejects.toThrow(
      'Codefresh Pipeline Failure. Status was Error: timed out'
    );
  });

  test('deleteBuild destroys each active CLI-backed deploy and ignores inactive or non-CLI deploys', async () => {
    const codefresh = createDeploy({
      active: true,
      env: { PLAIN: 'value' },
      deployable: {
        ...createDeploy().deployable,
        type: DeployTypes.CODEFRESH,
        destroyTrigger: undefined,
      },
    });
    const aurora = createCliDeploy();
    const inactive = createCliDeploy(DeployTypes.AURORA_RESTORE, {
      uuid: 'inactive-deploy',
      active: false,
    });
    const docker = createCliDeploy(DeployTypes.DOCKER);
    const withGraphFetched = jest.fn().mockResolvedValue([codefresh, aurora, inactive, docker]);
    const where = jest.fn(() => ({ withGraphFetched }));
    mockDeployQuery.mockReturnValue({ where });
    mockExecute.mockResolvedValue('destroy-id\n');

    await deleteBuild({ id: 42, uuid: 'build-uuid' } as any);

    expect(where).toHaveBeenCalledWith({ buildId: 42 });
    expect(mockWithLogContext).toHaveBeenCalledTimes(2);
    expect(codefresh.$query().patch).toHaveBeenCalledWith({ sha: null });
    expect(
      mockExecute.mock.calls.some(([file, args]) => file === 'codefresh' && args.includes('deployable/destroy'))
    ).toBe(true);
    expect(
      mockExecute.mock.calls.some(([command]) =>
        command.includes('scripts/aurora-helper.ts destroy --stackName build-uuid-build-sha')
      )
    ).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalledWith('CLI: deleting');
    expect(mockLoggerInfo).toHaveBeenCalledWith('CLI: deleted');
  });

  test('deleteBuild leaves a pinned aurora database in place', async () => {
    const pinned = createCliDeploy(DeployTypes.AURORA_RESTORE, { cname: 'database-rw.example.test' });
    const withGraphFetched = jest.fn().mockResolvedValue([pinned]);
    const where = jest.fn(() => ({ withGraphFetched }));
    mockDeployQuery.mockReturnValue({ where });

    await deleteBuild({ id: 42, uuid: 'build-uuid' } as any);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalledWith('CLI: deleting');
  });

  test('codefresh deploy and destroy omit optional triggers and destroy preserves undefined CLI output', async () => {
    const deploy = createDeploy({
      env: { ENABLED: true, EMPTY: null },
      deployable: {
        ...createDeploy().deployable,
        deployTrigger: undefined,
        destroyTrigger: undefined,
      },
    });
    mockExecute.mockResolvedValueOnce('deploy-id\n');

    await expect(codefreshDeploy(deploy, deploy.build, deploy.deployable)).resolves.toBe('deploy-id');
    expect(mockExecute.mock.calls[0][1].some((arg: string) => arg.startsWith('--trigger='))).toBe(false);

    mockExecute.mockClear();
    mockExecute.mockResolvedValueOnce(undefined);
    await expect(codefreshDestroy(deploy)).resolves.toBeUndefined();
    expect(mockExecute.mock.calls[0][1].some((arg: string) => arg.startsWith('--trigger='))).toBe(false);
    expect(mockDeleteExternalSecret).not.toHaveBeenCalled();
    expect(mockUpdateLogContext).toHaveBeenCalledWith({ buildUuid: 'build-uuid' });
  });
});

describe('isPinnedCname', () => {
  test.each([
    [null, false],
    [undefined, false],
    ['', false],
    ['   ', false],
    ['app-db-env.cluster-abc123.us-west-2.rds.amazonaws.com', false],
    ['app-db-env.abc123.us-west-2.rds.amazonaws.com', false],
    ['APP-DB-ENV.CLUSTER-ABC123.US-WEST-2.RDS.AMAZONAWS.COM.', false],
    ['  app-db-env.cluster-abc123.us-west-2.rds.amazonaws.com  ', false],
    ['app-db-env.cluster-abc123.cn-north-1.rds.amazonaws.com.cn', false],
    ['app-db-rw.example.com', true],
    ['app-db-rw.example.com.', true],
    ['rds.amazonaws.com.example.com', true],
    ['app-db.cluster-abc123.us-west-2.rds.amazonaws.com.example.com', true],
  ])('%p → %p', (cname, expected) => {
    expect(isPinnedCname(cname)).toBe(expected);
  });
});
