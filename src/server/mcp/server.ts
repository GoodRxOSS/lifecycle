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

import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { getLogger } from 'server/lib/logger';
import BuildService from 'server/services/build';
import SitesService, { SitesServiceError } from 'server/services/sites';
import { getNativeBuildJobs } from 'server/lib/kubernetes/getNativeBuildJobs';
import { getDeploymentJobs } from 'server/lib/kubernetes/getDeploymentJobs';
import { getK8sJobStatusAndPod } from 'server/lib/logStreamingHelper';
import { getLogArchivalService } from 'server/services/logArchival';
import GlobalConfigService from 'server/services/globalConfig';

const MAX_LOG_TAIL_LINES = 2000;
const DEFAULT_LOG_TAIL_LINES = 200;
const MAX_LOG_BYTES = 200_000;

type JsonRecord = Record<string, unknown>;

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function summarizeDeploy(deploy: JsonRecord): JsonRecord {
  const deployable = deploy.deployable as JsonRecord | undefined;
  const repository = deploy.repository as JsonRecord | undefined;

  // Deliberately omit env/initEnv: deploy env vars can contain secrets and must not
  // be exposed through read tools.
  return {
    name: deployable?.name ?? null,
    type: deployable?.type ?? null,
    status: deploy.status ?? null,
    statusMessage: deploy.statusMessage ?? null,
    active: deploy.active ?? null,
    branchName: deploy.branchName ?? null,
    publicUrl: deploy.publicUrl ?? null,
    dockerImage: deploy.dockerImage ?? null,
    sha: deploy.sha ?? null,
    repository: repository?.fullName ?? null,
    updatedAt: deploy.updatedAt ?? null,
  };
}

function summarizeBuild(
  build: JsonRecord,
  { includeServices = false }: { includeServices?: boolean } = {}
): JsonRecord {
  const pullRequest = build.pullRequest as JsonRecord | undefined;
  const deploys = (build.deploys as JsonRecord[] | undefined) ?? [];

  const summary: JsonRecord = {
    uuid: build.uuid,
    status: build.status,
    statusMessage: build.statusMessage ?? null,
    namespace: build.namespace ?? null,
    isStatic: build.isStatic ?? null,
    createdAt: build.createdAt ?? null,
    updatedAt: build.updatedAt ?? null,
    pullRequest: pullRequest
      ? {
          title: pullRequest.title ?? null,
          repository: pullRequest.fullName ?? null,
          number: pullRequest.pullRequestNumber ?? null,
          branch: pullRequest.branchName ?? null,
          author: pullRequest.githubLogin ?? null,
          status: pullRequest.status ?? null,
        }
      : null,
  };

  if (includeServices) {
    summary.services = deploys.map(summarizeDeploy);
  } else {
    summary.serviceCount = deploys.length;
    summary.serviceNames = deploys.map((deploy) => (deploy.deployable as JsonRecord | undefined)?.name).filter(Boolean);
  }

  return summary;
}

async function getBuildDetail(uuid: string): Promise<JsonRecord | null> {
  const build = await new BuildService().getBuildByUUID(uuid);
  if (!build) {
    return null;
  }

  return summarizeBuild(build as unknown as JsonRecord, { includeServices: true });
}

async function readJobLogs(
  uuid: string,
  serviceName: string,
  jobType: 'build' | 'deploy',
  jobName: string | undefined,
  tailLines: number
): Promise<JsonRecord> {
  const namespace = `env-${uuid}`;
  const jobs =
    jobType === 'build'
      ? await getNativeBuildJobs(serviceName, namespace)
      : await getDeploymentJobs(serviceName, namespace);

  if (jobs.length === 0) {
    return { uuid, service: serviceName, jobType, message: 'No jobs found for this service' };
  }

  const sorted = [...jobs].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const job = jobName ? sorted.find((candidate) => candidate.jobName === jobName) : sorted[0];
  if (!job) {
    return {
      uuid,
      service: serviceName,
      jobType,
      message: `Job ${jobName} not found`,
      availableJobs: sorted.map((candidate) => candidate.jobName),
    };
  }

  const base: JsonRecord = {
    uuid,
    service: serviceName,
    jobType,
    jobName: job.jobName,
    jobStatus: job.status,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
  };

  const podInfo = await getK8sJobStatusAndPod(job.jobName, namespace).catch(() => null);
  if (podInfo?.podName) {
    // Same config loading as the job helpers above: the default chain works both
    // in-cluster and against a local kubeconfig, unlike loadFromCluster-first helpers.
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    // Container names prefixed with "[init] " are init containers, not addressable by that label.
    const containers = (podInfo.containers || []).map((c) => c.name).filter(Boolean);
    const container = containers.find((name) => !name.startsWith('[init]')) || containers[0]?.replace(/^\[init\] /, '');
    const logResponse = await coreV1.readNamespacedPodLog(
      podInfo.podName,
      namespace,
      container,
      false, // follow
      undefined, // insecureSkipTLSVerifyBackend
      MAX_LOG_BYTES,
      undefined, // pretty
      false, // previous
      undefined, // sinceSeconds
      tailLines,
      true // timestamps
    );

    return { ...base, source: 'live', podName: podInfo.podName, logs: logResponse.body ?? '' };
  }

  // Pod is gone; fall back to archived logs when archival is enabled.
  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  if (globalConfig.logArchival?.enabled) {
    try {
      const archived = await getLogArchivalService().getArchivedLogs(namespace, jobType, serviceName, job.jobName);
      if (archived !== null) {
        const lines = archived.split('\n');
        const tail = lines.length > tailLines ? lines.slice(-tailLines).join('\n') : archived;
        return { ...base, source: 'archived', logs: tail };
      }
    } catch (error) {
      getLogger().warn({ error }, `MCP: archived log fetch failed jobName=${job.jobName}`);
    }
  }

  return { ...base, message: 'Job pod no longer exists and no archived logs were found' };
}

/** One McpServer per authenticated session; tools run under that user's identity. */
export function createLifecycleMcpServer(identity: RequestUserIdentity): McpServer {
  const server = new McpServer({ name: 'lifecycle', version: '1.0.0' });

  server.registerTool(
    'list_builds',
    {
      title: 'List builds',
      description:
        'List Lifecycle preview environments (builds), most recently updated first. ' +
        'Supports text search across uuid/namespace/PR title/repo/author and filtering to your own environments.',
      inputSchema: {
        search: z.string().optional().describe('Search term (uuid, namespace, PR title, repo, author)'),
        myEnvironmentsOnly: z.boolean().optional().describe('Only environments created from your pull requests'),
        page: z.number().int().min(1).optional().describe('Page number (default 1)'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25, max 100)'),
      },
    },
    async ({ search, myEnvironmentsOnly, page, limit }) => {
      const author = identity.githubUsername || identity.preferredUsername || '';
      if (myEnvironmentsOnly && !author) {
        // An empty author would silently disable the filter and return everything.
        return errorResult('Your account has no associated GitHub username, so "my environments" cannot be filtered.');
      }

      const { data, paginationMetadata } = await new BuildService().getAllBuilds(
        '',
        myEnvironmentsOnly ? author : '',
        search,
        { page: page || 1, limit: Math.min(limit || 25, 100) }
      );

      return textResult({
        builds: (data as unknown as JsonRecord[]).map((build) => summarizeBuild(build)),
        pagination: paginationMetadata,
      });
    }
  );

  server.registerTool(
    'get_build',
    {
      title: 'Get build',
      description: 'Get details for one Lifecycle build (environment) by UUID, including its services and their URLs.',
      inputSchema: { uuid: z.string().describe('Build UUID, e.g. cute-mouse-123456') },
    },
    async ({ uuid }) => {
      const detail = await getBuildDetail(uuid);
      return detail ? textResult(detail) : errorResult(`Build ${uuid} not found`);
    }
  );

  server.registerTool(
    'list_services',
    {
      title: 'List services',
      description: 'List the services in a Lifecycle build with status, active branch, public URL and image.',
      inputSchema: { uuid: z.string().describe('Build UUID') },
    },
    async ({ uuid }) => {
      const detail = await getBuildDetail(uuid);
      if (!detail) {
        return errorResult(`Build ${uuid} not found`);
      }

      return textResult({ uuid, status: detail.status, services: detail.services });
    }
  );

  server.registerTool(
    'get_job_logs',
    {
      title: 'Get job logs',
      description:
        'Fetch build-job or deploy-job logs for a service in a Lifecycle build. ' +
        'Defaults to the most recent job; falls back to archived logs when the pod is gone.',
      inputSchema: {
        uuid: z.string().describe('Build UUID'),
        service: z.string().describe('Service name within the build'),
        jobType: z.enum(['build', 'deploy']).describe('Which job logs to fetch'),
        jobName: z.string().optional().describe('Specific job name; defaults to the most recent job'),
        tailLines: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOG_TAIL_LINES)
          .optional()
          .describe(`Number of trailing log lines (default ${DEFAULT_LOG_TAIL_LINES})`),
      },
    },
    async ({ uuid, service, jobType, jobName, tailLines }) => {
      const build = await new BuildService().getBuildByUUID(uuid);
      if (!build) {
        return errorResult(`Build ${uuid} not found`);
      }

      try {
        const result = await readJobLogs(uuid, service, jobType, jobName, tailLines || DEFAULT_LOG_TAIL_LINES);
        return textResult(result);
      } catch (error) {
        const httpError = error as { statusCode?: number; body?: { message?: string }; message?: string };
        getLogger().warn({ error }, `MCP: get_job_logs failed uuid=${uuid} service=${service}`);
        return errorResult(
          `Failed to fetch ${jobType} job logs: ` +
            (httpError.body?.message || httpError.message || 'unknown error') +
            (httpError.statusCode ? ` (kubernetes status ${httpError.statusCode})` : '')
        );
      }
    }
  );

  server.registerTool(
    'list_sites',
    {
      title: 'List sites',
      description: 'List static artifact sites published via Lifecycle sites.',
      inputSchema: {
        mineOnly: z.boolean().optional().describe('Only sites you created or updated'),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ mineOnly, page, limit }) => {
      if (mineOnly && !identity.email) {
        // Sites record the creator's real email; a synthesized fallback would never match.
        return errorResult('Your account has no email claim, so "mine only" cannot be filtered.');
      }

      try {
        const result = await new SitesService().listSites({
          user: mineOnly ? identity.email : undefined,
          page,
          limit,
        });
        return textResult(result);
      } catch (error) {
        if (error instanceof SitesServiceError) {
          return errorResult(error.message);
        }
        throw error;
      }
    }
  );

  server.registerTool(
    'get_site',
    {
      title: 'Get site',
      description: 'Get one static artifact site by id, including its URL and expiry.',
      inputSchema: { siteId: z.string().describe('Site id') },
    },
    async ({ siteId }) => {
      try {
        return textResult(await new SitesService().getSite(siteId));
      } catch (error) {
        if (error instanceof SitesServiceError) {
          return errorResult(error.message);
        }
        throw error;
      }
    }
  );

  server.registerResource(
    'build',
    new ResourceTemplate('lifecycle://builds/{uuid}', { list: undefined }),
    {
      title: 'Lifecycle build',
      description: 'Build (preview environment) detail document',
      mimeType: 'application/json',
    },
    async (uri, { uuid }) => {
      const detail = await getBuildDetail(String(uuid));
      if (!detail) {
        throw new Error(`Build ${uuid} not found`);
      }

      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(detail, null, 2) }],
      };
    }
  );

  return server;
}
