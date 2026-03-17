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

import yaml from 'js-yaml';
import { customAlphabet } from 'nanoid';
import { Build, Deploy } from 'server/models';
import * as YamlService from 'server/models/yaml';
import GlobalConfigService from 'server/services/globalConfig';
import { shellPromise } from 'server/lib/shell';
import { createKubernetesJob } from 'server/lib/kubernetes/jobFactory';
import { ensureServiceAccountForJob } from 'server/lib/kubernetes/common/serviceAccount';
import { waitForJobAndGetLogs } from 'server/lib/nativeBuild/utils';
import { getLogArchivalService } from 'server/services/logArchival';
import { RdsDefaultsConfig } from 'server/services/types/globalConfig';
import { DeployStatus, DeployTypes } from 'shared/constants';

const generateJobId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);
const RUNNER_COMMAND = `
set -eu
printf "%s" "$RDS_JOB_SPEC" > /tmp/rds-job-spec.json
lifecycle-rds "$RDS_ACTION" --spec /tmp/rds-job-spec.json
`.trim();

export interface ResolvedRdsJobSpec extends RdsDefaultsConfig {
  action: 'restore' | 'destroy';
  type: 'aurora' | 'rds';
  buildUuid: string;
  deployUuid: string;
  serviceName: string;
  sourceTag: {
    key: string;
    value: string;
  };
  additionalTags: Record<string, string>;
}

export interface RdsJobResult {
  success: boolean;
  logs: string;
  jobName: string;
}

function mergeRdsConfig(defaults: RdsDefaultsConfig, config: YamlService.RdsServiceConfig): RdsDefaultsConfig {
  return {
    ...defaults,
    ...config,
    sourceTag: {
      ...defaults.sourceTag,
      ...config.sourceTag,
    },
    additionalTags: {
      ...(defaults.additionalTags || {}),
      ...(config.additionalTags || {}),
    },
  };
}

function validateResolvedSpec(spec: ResolvedRdsJobSpec): void {
  const requiredStringFields: Array<keyof ResolvedRdsJobSpec> = [
    'image',
    'vpcId',
    'accountId',
    'region',
    'subnetGroupName',
    'engine',
    'engineVersion',
    'instanceSize',
    'restoreSize',
    'serviceName',
    'buildUuid',
    'deployUuid',
  ];

  for (const field of requiredStringFields) {
    const value = spec[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Missing required rds config field: ${field}`);
    }
  }

  if (!spec.sourceTag?.key?.trim()) {
    throw new Error('Missing required rds sourceTag.key');
  }

  if (!spec.sourceTag?.value?.trim()) {
    throw new Error('Missing required rds sourceTag.value');
  }

  if (!spec.securityGroupIds || spec.securityGroupIds.length === 0) {
    throw new Error('Missing required rds securityGroupIds');
  }
}

async function loadRdsConfigForDeploy(deploy: Deploy): Promise<YamlService.RdsServiceConfig> {
  await deploy.$fetchGraph('[build.pullRequest.repository, deployable.repository]');

  if (!deploy.deployable?.name) {
    throw new Error('RDS jobs currently require a YAML-backed deployable');
  }

  const repository = deploy.deployable?.repository || deploy.build?.pullRequest?.repository;
  const branchName = deploy.deployable?.commentBranchName || deploy.branchName || deploy.deployable?.branchName;
  const serviceName = deploy.deployable.name;

  if (!repository?.fullName || !branchName) {
    throw new Error('Unable to resolve repository/branch for rds config lookup');
  }

  const yamlConfig = await YamlService.fetchLifecycleConfigByRepository(repository, branchName);
  if (!yamlConfig) {
    throw new Error(`Unable to fetch lifecycle config for ${repository.fullName}@${branchName}`);
  }

  const service = YamlService.getDeployingServicesByName(yamlConfig, serviceName);
  const rdsConfig = service ? YamlService.getRdsConfig(service) : null;
  if (!rdsConfig) {
    throw new Error(`Unable to find rds config for service ${serviceName}`);
  }

  return rdsConfig;
}

export async function resolveRdsJobSpec(deploy: Deploy, action: 'restore' | 'destroy'): Promise<ResolvedRdsJobSpec> {
  await deploy.$fetchGraph('[build, deployable]');

  if (!deploy.build?.uuid || !deploy.deployable?.name) {
    throw new Error('RDS jobs require a deploy with build and deployable context');
  }

  const rdsConfig = await loadRdsConfigForDeploy(deploy);
  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  const defaults = globalConfig.rdsDefaults?.[rdsConfig.type];

  if (!defaults) {
    throw new Error(`Missing global_config.rdsDefaults.${rdsConfig.type}`);
  }

  const merged = mergeRdsConfig(defaults, rdsConfig);

  const spec: ResolvedRdsJobSpec = {
    ...merged,
    action,
    type: rdsConfig.type,
    buildUuid: deploy.build.uuid,
    deployUuid: deploy.uuid,
    serviceName: deploy.deployable.name,
    sourceTag: {
      key: merged.sourceTag.key,
      value: merged.sourceTag.value,
    },
    additionalTags: merged.additionalTags || {},
  };

  validateResolvedSpec(spec);
  return spec;
}

function createRdsJobName(deploy: Deploy, action: 'restore' | 'destroy'): string {
  const jobId = generateJobId();
  const shortSha = deploy.sha?.substring(0, 7) || 'unknown';
  const phase = action === 'restore' ? 'build' : 'destroy';
  let jobName = `${deploy.uuid}-${phase}-${jobId}-${shortSha}`.substring(0, 63);
  if (jobName.endsWith('-')) {
    jobName = jobName.slice(0, -1);
  }
  return jobName;
}

function buildRdsJobManifest(deploy: Deploy, namespace: string, serviceAccountName: string, spec: ResolvedRdsJobSpec) {
  const jobName = createRdsJobName(deploy, spec.action);
  const timeout = spec.jobTimeout || 5400;

  const job = createKubernetesJob({
    name: jobName,
    namespace,
    appName: 'lfc-rds',
    component: 'build',
    serviceAccount: serviceAccountName,
    timeout,
    labels: {
      'lfc/service': spec.serviceName,
      'lfc/deploy-uuid': spec.deployUuid,
      'lfc/build-uuid': spec.buildUuid,
      'lfc/job-kind': 'rds',
      'lfc/rds-type': spec.type,
      'lfc/action': spec.action,
    },
    annotations: {
      'lfc/source-tag-key': spec.sourceTag.key,
      'lfc/source-tag-value': spec.sourceTag.value,
    },
    containers: [
      {
        name: 'rds-runner',
        image: spec.image,
        command: ['/bin/sh', '-c'],
        args: [RUNNER_COMMAND],
        env: [
          { name: 'AWS_REGION', value: spec.region },
          { name: 'RDS_ACTION', value: spec.action },
          { name: 'RDS_JOB_SPEC', value: JSON.stringify(spec) },
        ],
        resources: {
          requests: { cpu: '100m', memory: '256Mi' },
          limits: { cpu: '500m', memory: '1Gi' },
        },
      },
    ],
  });

  return { jobName, manifest: yaml.dump(job, { quotingType: '"', forceQuotes: true }) };
}

async function archiveRdsJob(
  deploy: Deploy,
  spec: ResolvedRdsJobSpec,
  jobName: string,
  status: 'Complete' | 'Failed',
  logs: string,
  startedAt?: string,
  completedAt?: string,
  duration?: number
) {
  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  if (!globalConfig.logArchival?.enabled) return;

  const archivalService = getLogArchivalService();
  await archivalService.archiveLogs(
    {
      jobName,
      jobType: 'build',
      jobKind: 'rds',
      serviceName: spec.serviceName,
      namespace: deploy.build.namespace,
      status,
      sha: deploy.sha || '',
      buildUuid: deploy.build.uuid,
      deployUuid: deploy.uuid,
      rdsType: spec.type,
      archivedAt: new Date().toISOString(),
      startedAt,
      completedAt,
      duration,
    },
    logs
  );
}

export async function runRdsJob(deploy: Deploy, action: 'restore' | 'destroy'): Promise<RdsJobResult> {
  await deploy.$fetchGraph('[build, deployable]');

  if (!deploy.build?.namespace) {
    throw new Error('Unable to resolve namespace for rds job');
  }

  const spec = await resolveRdsJobSpec(deploy, action);
  const namespace = deploy.build.namespace;
  const serviceAccountName = await ensureServiceAccountForJob(namespace, action === 'restore' ? 'build' : 'deploy');
  const { jobName, manifest } = buildRdsJobManifest(deploy, namespace, serviceAccountName, spec);

  await shellPromise(`cat <<'EOF' | kubectl apply -f -
${manifest}
EOF`);

  try {
    const result = await waitForJobAndGetLogs(jobName, namespace, spec.jobTimeout || 5400);
    await archiveRdsJob(
      deploy,
      spec,
      jobName,
      result.success ? 'Complete' : 'Failed',
      result.logs,
      result.startedAt,
      result.completedAt,
      result.duration
    );
    return {
      success: result.success,
      logs: result.logs,
      jobName,
    };
  } catch (error: any) {
    const logs = `RDS job failed: ${error.message || String(error)}`;
    await archiveRdsJob(deploy, spec, jobName, 'Failed', logs);
    return {
      success: false,
      logs,
      jobName,
    };
  }
}

export async function deleteBuild(build: Build): Promise<void> {
  const deploys = await Deploy.query().where({ buildId: build.id, active: true }).withGraphFetched({
    deployable: true,
    build: true,
  });

  await Promise.all(
    deploys
      .filter((deploy) => deploy.deployable?.type === DeployTypes.RDS)
      .map(async (deploy) => {
        await deploy.$query().patch({
          status: DeployStatus.BUILDING,
          statusMessage: 'Running RDS destroy job',
        });
        const result = await runRdsJob(deploy, 'destroy');
        if (!result.success) {
          throw new Error(`RDS destroy failed for ${deploy.deployable?.name || deploy.uuid}`);
        }
      })
  );
}
