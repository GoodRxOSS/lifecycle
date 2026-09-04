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

const mockCreateNamespacedJob = jest.fn();
const mockLoadFromDefault = jest.fn();
const mockMakeApiClient = jest.fn(() => ({ createNamespacedJob: mockCreateNamespacedJob }));
const mockLoggerInfo = jest.fn();
const mockWaitForCompletion = jest.fn();
const mockJobMonitorConstructor = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  BatchV1Api: class MockBatchV1Api {},
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: mockLoadFromDefault,
    makeApiClient: mockMakeApiClient,
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: mockLoggerInfo }),
}));

jest.mock('server/lib/kubernetes/JobMonitor', () => ({
  JobMonitor: jest.fn().mockImplementation((...args: unknown[]) => {
    mockJobMonitorConstructor(...args);
    return { waitForCompletion: mockWaitForCompletion };
  }),
}));

import { BatchV1Api } from '@kubernetes/client-node';
import { buildAgentPrewarmJobSpec, createAgentPrewarmJob, monitorAgentPrewarmJob } from '../prewarmJobFactory';

describe('prewarmJobFactory', () => {
  const baseOpts = {
    jobName: 'agent-prewarm-sample',
    namespace: 'env-sample',
    pvcName: 'agent-prewarm-pvc-sample',
    image: 'workspace-image:latest',
    apiKeySecretName: 'agent-secret-sample',
    repoUrl: 'https://github.com/example-org/example-repo.git',
    branch: 'sample-branch',
    revision: 'abcdef1234567890',
    workspacePath: '/workspace/example-repo',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps clone/bootstrap steps separate from runtime seeding', () => {
    const job = buildAgentPrewarmJobSpec(baseOpts);
    const initWorkspace = job.spec!.template.spec!.initContainers!.find(
      (container) => container.name === 'init-workspace'
    );
    const seedRuntimeConfig = job.spec!.template.spec!.initContainers!.find(
      (container) => container.name === 'seed-runtime-config'
    );

    expect(initWorkspace).toBeDefined();
    expect(seedRuntimeConfig).toBeDefined();
    expect(initWorkspace!.command![2]).toContain('git clone --progress --depth 50 --branch "sample-branch"');
    expect(initWorkspace!.command![2]).not.toContain('git config --global user.name');
    expect(initWorkspace!.command![2]).not.toContain('git config --global --add safe.directory');
    expect(initWorkspace!.command![2]).not.toContain('pre-push');
    expect(seedRuntimeConfig!.command![2]).toContain(
      'git config --global --add safe.directory "/workspace/example-repo"'
    );
    expect(seedRuntimeConfig!.command![2]).toContain('pre-push');
  });

  it('configures git auth before clone when GitHub token forwarding is enabled', () => {
    const job = buildAgentPrewarmJobSpec({ ...baseOpts, hasGitHubToken: true });
    const initWorkspace = job.spec!.template.spec!.initContainers!.find(
      (container) => container.name === 'init-workspace'
    );

    expect(initWorkspace).toBeDefined();
    const script = initWorkspace!.command![2];
    const credentialHelperIndex = script.indexOf(
      'git config --global credential.helper \'!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f\''
    );
    const cloneIndex = script.indexOf('git clone --progress --depth 50 --branch "sample-branch"');

    expect(credentialHelperIndex).toBeGreaterThan(-1);
    expect(cloneIndex).toBeGreaterThan(-1);
    expect(credentialHelperIndex).toBeLessThan(cloneIndex);
  });

  it('applies optional scheduling, forwarding, skill, and timeout configuration to the job', () => {
    const resources = { requests: { cpu: '250m' }, limits: { memory: '512Mi' } };
    const job = buildAgentPrewarmJobSpec({
      ...baseOpts,
      workspaceGatewayImage: 'gateway-image:latest',
      hasGitHubToken: true,
      forwardedAgentEnv: { PUBLIC_VALUE: 'visible', SECRET_VALUE: 'hidden' },
      forwardedAgentSecretRefs: [{ envKey: 'SECRET_VALUE', provider: 'vault', path: 'apps/secret' }],
      forwardedAgentSecretServiceName: 'workspace-service',
      skillPlan: {
        version: 1,
        skills: [
          {
            repo: 'example-org/skills',
            repoUrl: 'https://github.com/example-org/skills.git',
            branch: 'main',
            path: 'skills/review',
            source: 'environment',
          },
        ],
      },
      buildUuid: 'build-1',
      nodeSelector: { pool: 'agent' },
      serviceAccountName: 'agent-prewarm',
      resources,
      timeoutSeconds: 45,
    });

    const spec = job.spec!.template.spec!;
    const initWorkspace = spec.initContainers!.find((container) => container.name === 'init-workspace')!;
    const initSkills = spec.initContainers!.find((container) => container.name === 'init-skills')!;
    const seedRuntime = spec.initContainers!.find((container) => container.name === 'seed-runtime-config')!;

    expect(job.spec!.activeDeadlineSeconds).toBe(45);
    expect(job.metadata!.labels).toEqual(expect.objectContaining({ lc_uuid: 'build-1' }));
    expect(spec.nodeSelector).toEqual({ pool: 'agent' });
    expect(spec.serviceAccountName).toBe('agent-prewarm');
    expect(initSkills.image).toBe('gateway-image:latest');
    const encodedSkillPlan = initSkills.command![2].match(/skills-bootstrap\.mjs" "([^"]+)"/)?.[1];
    expect(encodedSkillPlan).toBeDefined();
    expect(JSON.parse(Buffer.from(encodedSkillPlan!, 'base64').toString('utf8'))).toEqual(
      expect.objectContaining({ skills: [expect.objectContaining({ repo: 'example-org/skills' })] })
    );
    expect(initWorkspace.resources).toBe(resources);
    expect(initWorkspace.env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'PUBLIC_VALUE',
          valueFrom: { secretKeyRef: { name: 'agent-secret-sample', key: 'PUBLIC_VALUE' } },
        }),
        expect.objectContaining({ name: 'SECRET_VALUE' }),
        expect.objectContaining({ name: 'GITHUB_TOKEN' }),
        expect.objectContaining({ name: 'GH_TOKEN' }),
      ])
    );
    expect(seedRuntime.env).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'SECRET_VALUE' })]));
  });

  it('uses the workspace image for skill bootstrapping when no gateway image is configured', () => {
    const job = buildAgentPrewarmJobSpec({
      ...baseOpts,
      skillPlan: {
        version: 1,
        skills: [
          {
            repo: 'example-org/skills',
            repoUrl: 'https://github.com/example-org/skills.git',
            branch: 'main',
            path: 'skills/review',
            source: 'environment',
          },
        ],
      },
    });

    expect(job.spec!.template.spec!.initContainers!.find((container) => container.name === 'init-skills')!.image).toBe(
      baseOpts.image
    );
  });

  it('creates the generated job through the default Kubernetes context and returns the API body', async () => {
    const createdJob = { metadata: { name: baseOpts.jobName, namespace: baseOpts.namespace, uid: 'job-uid' } };
    mockCreateNamespacedJob.mockResolvedValue({ body: createdJob });

    await expect(createAgentPrewarmJob(baseOpts)).resolves.toBe(createdJob);

    expect(mockLoadFromDefault).toHaveBeenCalledTimes(1);
    expect(mockMakeApiClient).toHaveBeenCalledWith(BatchV1Api);
    expect(mockCreateNamespacedJob).toHaveBeenCalledWith(
      baseOpts.namespace,
      expect.objectContaining({ metadata: expect.objectContaining({ name: baseOpts.jobName }) })
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      `Prewarm: job started jobName=${baseOpts.jobName} namespace=${baseOpts.namespace}`
    );
  });

  it('propagates Kubernetes creation failures without logging a successful start', async () => {
    const error = new Error('Kubernetes unavailable');
    mockCreateNamespacedJob.mockRejectedValue(error);

    await expect(createAgentPrewarmJob(baseOpts)).rejects.toBe(error);

    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 30 * 60],
    [75, 75],
  ])('monitors completion with timeout %p as %i seconds', async (timeoutSeconds, expectedTimeout) => {
    const completion = { succeeded: true, logs: 'complete' };
    mockWaitForCompletion.mockResolvedValue(completion);

    await expect(monitorAgentPrewarmJob('prewarm-job', 'environment', timeoutSeconds)).resolves.toBe(completion);

    expect(mockJobMonitorConstructor).toHaveBeenCalledWith('prewarm-job', 'environment');
    expect(mockWaitForCompletion).toHaveBeenCalledWith({
      timeoutSeconds: expectedTimeout,
      containerFilters: ['complete'],
      logPrefix: 'agent-prewarm',
    });
  });
});
