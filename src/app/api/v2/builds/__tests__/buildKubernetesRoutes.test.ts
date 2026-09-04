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

import { NextRequest } from 'next/server';

const mockGetBuildByUUID = jest.fn();
const mockAssertBuildRepositoryAllowed = jest.fn();
const mockGetEnvironmentPods = jest.fn();
const mockGetDeploymentPods = jest.fn();
const mockGetNativeBuildJobs = jest.fn();
const mockGetDeploymentJobs = jest.fn();
const mockGetLogStreamInfo = jest.fn();

jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('server/lib/createApiHandler', () => ({
  createPrincipalApiHandler:
    (_policy: unknown, handler: (...args: unknown[]) => Promise<Response>) => (req: NextRequest, context: unknown) =>
      handler(req, { kind: 'service', scopes: ['env:read'] }, context),
}));
jest.mock('server/lib/repositoryAuthorization', () => ({
  assertBuildRepositoryAllowed: (...args: unknown[]) => mockAssertBuildRepositoryAllowed(...args),
}));
jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ getBuildByUUID: mockGetBuildByUUID })),
}));
jest.mock('server/lib/kubernetes/getEnvironmentPods', () => ({
  getEnvironmentPods: (...args: unknown[]) => mockGetEnvironmentPods(...args),
}));
jest.mock('server/lib/kubernetes/getDeploymentPods', () => ({
  getDeploymentPods: (...args: unknown[]) => mockGetDeploymentPods(...args),
}));
jest.mock('server/lib/kubernetes/getNativeBuildJobs', () => ({
  getNativeBuildJobs: (...args: unknown[]) => mockGetNativeBuildJobs(...args),
}));
jest.mock('server/lib/kubernetes/getDeploymentJobs', () => ({
  getDeploymentJobs: (...args: unknown[]) => mockGetDeploymentJobs(...args),
}));
jest.mock('server/services/logStreaming', () => ({
  LogStreamingService: jest.fn().mockImplementation(() => ({ getLogStreamInfo: mockGetLogStreamInfo })),
}));

import { HttpError } from '@kubernetes/client-node';
import { GET as getEnvironmentPodsRoute } from 'src/app/api/v2/builds/[uuid]/pods/route';
import { GET as getDeploymentPodsRoute } from 'src/app/api/v2/builds/[uuid]/services/[name]/pods/route';
import { GET as getBuildJobsRoute } from 'src/app/api/v2/builds/[uuid]/services/[name]/build-jobs/route';
import { GET as getBuildJobRoute } from 'src/app/api/v2/builds/[uuid]/services/[name]/build-jobs/[jobName]/route';
import { GET as getDeployJobsRoute } from 'src/app/api/v2/builds/[uuid]/services/[name]/deploy-jobs/route';
import { GET as getDeployJobRoute } from 'src/app/api/v2/builds/[uuid]/services/[name]/deploy-jobs/[jobName]/route';

type RouteHandler = (req: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const build = { id: 41, uuid: 'build-1', repository: 'goodrx/sample' };

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { 'x-request-id': 'req-test', authorization: 'Bearer sample-token' },
  });
}

function kubernetesError(statusCode?: number): HttpError {
  return new HttpError(
    {
      statusCode: statusCode ?? 500,
      headers: {},
    } as never,
    '',
    statusCode ?? 500
  );
}

function kubernetesErrorWithoutResponse(): HttpError {
  return new HttpError(undefined as never, '', 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBuildByUUID.mockResolvedValue(build);
  mockAssertBuildRepositoryAllowed.mockResolvedValue(undefined);
  mockGetEnvironmentPods.mockResolvedValue([{ name: 'environment-pod' }]);
  mockGetDeploymentPods.mockResolvedValue([{ name: 'service-pod' }]);
  mockGetNativeBuildJobs.mockResolvedValue([{ name: 'build-job' }]);
  mockGetDeploymentJobs.mockResolvedValue([{ name: 'deploy-job' }]);
  mockGetLogStreamInfo.mockResolvedValue({ status: 'Complete', streamingRequired: false });
});

const collectionRoutes: Array<{
  label: string;
  handler: RouteHandler;
  path: string;
  validParams: Record<string, string>;
  invalidParams: Array<Record<string, string>>;
  workMock: jest.Mock;
  expectedWorkArgs: unknown[];
  responseKey: string;
  notFoundMessage: string;
}> = [
  {
    label: 'environment pods',
    handler: getEnvironmentPodsRoute,
    path: '/api/v2/builds/build-1/pods',
    validParams: { uuid: 'build-1' },
    invalidParams: [{ uuid: '' }],
    workMock: mockGetEnvironmentPods,
    expectedWorkArgs: ['build-1'],
    responseKey: 'pods',
    notFoundMessage: 'Environment not found.',
  },
  {
    label: 'service pods',
    handler: getDeploymentPodsRoute,
    path: '/api/v2/builds/build-1/services/web/pods',
    validParams: { uuid: 'build-1', name: 'web' },
    invalidParams: [
      { uuid: '', name: 'web' },
      { uuid: 'build-1', name: '' },
    ],
    workMock: mockGetDeploymentPods,
    expectedWorkArgs: ['web', 'build-1'],
    responseKey: 'pods',
    notFoundMessage: 'Environment or service not found.',
  },
  {
    label: 'build jobs',
    handler: getBuildJobsRoute,
    path: '/api/v2/builds/build-1/services/web/build-jobs',
    validParams: { uuid: 'build-1', name: 'web' },
    invalidParams: [
      { uuid: '', name: 'web' },
      { uuid: 'build-1', name: '' },
    ],
    workMock: mockGetNativeBuildJobs,
    expectedWorkArgs: ['web', 'env-build-1'],
    responseKey: 'builds',
    notFoundMessage: 'Environment or service not found.',
  },
  {
    label: 'deploy jobs',
    handler: getDeployJobsRoute,
    path: '/api/v2/builds/build-1/services/web/deploy-jobs',
    validParams: { uuid: 'build-1', name: 'web' },
    invalidParams: [
      { uuid: '', name: 'web' },
      { uuid: 'build-1', name: '' },
    ],
    workMock: mockGetDeploymentJobs,
    expectedWorkArgs: ['web', 'env-build-1'],
    responseKey: 'deployments',
    notFoundMessage: 'Environment or service not found.',
  },
];

describe.each(collectionRoutes)('$label route', (routeCase) => {
  it('rejects every missing required path parameter before looking up the build', async () => {
    for (const params of routeCase.invalidParams) {
      const response = await routeCase.handler(request(routeCase.path), { params: Promise.resolve(params) });
      expect(response.status).toBe(400);
    }

    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
    expect(routeCase.workMock).not.toHaveBeenCalled();
  });

  it('returns 404 and does not call Kubernetes when the live build is missing', async () => {
    mockGetBuildByUUID.mockResolvedValueOnce(null);

    const response = await routeCase.handler(request(routeCase.path), {
      params: Promise.resolve(routeCase.validParams),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('An unknown error occurred.');
    expect(routeCase.workMock).not.toHaveBeenCalled();
    expect(mockAssertBuildRepositoryAllowed).not.toHaveBeenCalled();
  });

  it('authorizes the resolved build and returns the Kubernetes collection', async () => {
    const response = await routeCase.handler(request(routeCase.path), {
      params: Promise.resolve(routeCase.validParams),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAssertBuildRepositoryAllowed).toHaveBeenCalledWith({ kind: 'service', scopes: ['env:read'] }, build);
    expect(routeCase.workMock).toHaveBeenCalledWith(...routeCase.expectedWorkArgs);
    expect(body.data[routeCase.responseKey]).toHaveLength(1);
  });

  it('maps a Kubernetes 404 to the route-specific not-found response', async () => {
    routeCase.workMock.mockRejectedValueOnce(kubernetesError(404));

    const response = await routeCase.handler(request(routeCase.path), {
      params: Promise.resolve(routeCase.validParams),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('An unknown error occurred.');
  });

  it('maps other Kubernetes failures to 502', async () => {
    routeCase.workMock.mockRejectedValueOnce(kubernetesError(503));

    const response = await routeCase.handler(request(routeCase.path), {
      params: Promise.resolve(routeCase.validParams),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.message).toBe('An unknown error occurred.');
  });

  it('maps a Kubernetes transport failure with no HTTP response to 502', async () => {
    routeCase.workMock.mockRejectedValueOnce(kubernetesErrorWithoutResponse());

    const response = await routeCase.handler(request(routeCase.path), {
      params: Promise.resolve(routeCase.validParams),
    });

    expect(response.status).toBe(502);
  });

  it('maps non-Kubernetes failures to 500', async () => {
    routeCase.workMock.mockRejectedValueOnce(new Error('unexpected failure'));

    const response = await routeCase.handler(request(routeCase.path), {
      params: Promise.resolve(routeCase.validParams),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.message).toBe('An unknown error occurred.');
  });
});

const jobRoutes: Array<{
  label: string;
  handler: RouteHandler;
  path: string;
  kind: 'build' | 'deploy';
  notFoundMessage: string;
}> = [
  {
    label: 'build job',
    handler: getBuildJobRoute,
    path: '/api/v2/builds/build-1/services/web/build-jobs/job-1',
    kind: 'build',
    notFoundMessage: 'Build not found',
  },
  {
    label: 'deploy job',
    handler: getDeployJobRoute,
    path: '/api/v2/builds/build-1/services/web/deploy-jobs/job-1',
    kind: 'deploy',
    notFoundMessage: 'Deploy not found',
  },
];

describe.each(jobRoutes)('$label detail route', (routeCase) => {
  const validParams = { uuid: 'build-1', name: 'web', jobName: 'job-1' };

  it('rejects each missing path parameter before build lookup', async () => {
    for (const params of [
      { uuid: '', name: 'web', jobName: 'job-1' },
      { uuid: 'build-1', name: 'web', jobName: '' },
      { uuid: 'build-1', name: '', jobName: 'job-1' },
    ]) {
      const response = await routeCase.handler(request(routeCase.path), { params: Promise.resolve(params) });
      expect(response.status).toBe(400);
    }

    expect(mockGetBuildByUUID).not.toHaveBeenCalled();
    expect(mockGetLogStreamInfo).not.toHaveBeenCalled();
  });

  it('returns 404 without starting log streaming when the live build is missing', async () => {
    mockGetBuildByUUID.mockResolvedValueOnce(null);

    const response = await routeCase.handler(request(routeCase.path), { params: Promise.resolve(validParams) });

    expect(response.status).toBe(404);
    expect(mockAssertBuildRepositoryAllowed).not.toHaveBeenCalled();
    expect(mockGetLogStreamInfo).not.toHaveBeenCalled();
  });

  it('authorizes the build and returns log-stream information', async () => {
    const response = await routeCase.handler(request(routeCase.path), { params: Promise.resolve(validParams) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAssertBuildRepositoryAllowed).toHaveBeenCalledWith({ kind: 'service', scopes: ['env:read'] }, build);
    expect(mockGetLogStreamInfo).toHaveBeenCalledWith('build-1', 'job-1', 'web', routeCase.kind, 41);
    expect(body.data).toEqual({ status: 'Complete', streamingRequired: false });
  });

  it('maps a service-level not-found error to 404', async () => {
    mockGetLogStreamInfo.mockRejectedValueOnce(new Error(routeCase.notFoundMessage));

    const response = await routeCase.handler(request(routeCase.path), { params: Promise.resolve(validParams) });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('An unknown error occurred.');
  });

  it.each([
    { label: 'an HttpError', error: () => kubernetesError(503) },
    { label: 'a Kubernetes message', error: () => new Error('Kubernetes connection closed') },
    { label: 'an explicit 502 status', error: () => ({ statusCode: 502 }) },
  ])('maps $label to 502', async ({ error }) => {
    mockGetLogStreamInfo.mockRejectedValueOnce(error());

    const response = await routeCase.handler(request(routeCase.path), { params: Promise.resolve(validParams) });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.message).toBe('An unknown error occurred.');
  });

  it('maps an unexpected log-stream failure to 500', async () => {
    mockGetLogStreamInfo.mockRejectedValueOnce(new Error('unexpected failure'));

    const response = await routeCase.handler(request(routeCase.path), { params: Promise.resolve(validParams) });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.message).toBe('An unknown error occurred.');
  });
});
