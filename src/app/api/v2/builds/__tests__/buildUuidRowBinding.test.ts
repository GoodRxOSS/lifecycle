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

const mockGetBuildByUUID = jest.fn();
const mockRedeployBuild = jest.fn();
const mockDestroyBuildEnvironment = jest.fn();
const mockRedeployServiceFromBuild = jest.fn();
const mockGetWebhooksForBuild = jest.fn();
const mockInvokeWebhooksForBuild = jest.fn();
const mockDestroyServiceDeployment = jest.fn();
const mockApplyBuildConfigPatch = jest.fn();
const mockApplyServiceOverrides = jest.fn();
const mockGetServiceOverrideStates = jest.fn();
const mockOverrideBuildQuery = jest.fn();
const mockRenderMetadataForBuild = jest.fn();
const mockGetLogStreamInfo = jest.fn();

jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('server/lib/createApiHandler', () => ({
  createPrincipalApiHandler:
    (_policy: unknown, handler: (...args: any[]) => Promise<unknown>) => (req: unknown, ctx: unknown) =>
      handler(req, { kind: 'service', scopes: ['env:read', 'env:write'] }, ctx),
}));
jest.mock('server/lib/repositoryAuthorization', () => ({ assertBuildRepositoryAllowed: jest.fn() }));
jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getBuildByUUID: mockGetBuildByUUID,
    redeployBuild: mockRedeployBuild,
    destroyBuildEnvironment: mockDestroyBuildEnvironment,
    redeployServiceFromBuild: mockRedeployServiceFromBuild,
    getWebhooksForBuild: mockGetWebhooksForBuild,
    invokeWebhooksForBuild: mockInvokeWebhooksForBuild,
  })),
}));
jest.mock('server/services/deployCleanup', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ destroyServiceDeployment: mockDestroyServiceDeployment })),
}));
jest.mock('server/services/override', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    db: { models: { Build: { query: mockOverrideBuildQuery } } },
    applyBuildConfigPatch: mockApplyBuildConfigPatch,
    applyServiceOverrides: mockApplyServiceOverrides,
    getServiceOverrideStates: mockGetServiceOverrideStates,
  })),
  BuildUuidValidationError: class BuildUuidValidationError extends Error {},
  ServiceOverrideNotFoundError: class ServiceOverrideNotFoundError extends Error {},
  ServiceOverrideNotEditableError: class ServiceOverrideNotEditableError extends Error {},
}));
jest.mock('server/services/buildMetadata', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ renderMetadataForBuild: mockRenderMetadataForBuild })),
  BuildMetadataError: class BuildMetadataError extends Error {
    constructor(message: string, public code: string) {
      super(message);
    }
  },
}));
jest.mock('server/services/logStreaming', () => ({
  LogStreamingService: jest.fn().mockImplementation(() => ({ getLogStreamInfo: mockGetLogStreamInfo })),
}));

import { NextRequest } from 'next/server';
import { PATCH as patchBuild } from 'src/app/api/v2/builds/[uuid]/route';
import { PUT as redeployBuild } from 'src/app/api/v2/builds/[uuid]/redeploy/route';
import { PUT as destroyBuild } from 'src/app/api/v2/builds/[uuid]/destroy/route';
import { PUT as redeployService } from 'src/app/api/v2/builds/[uuid]/services/[name]/redeploy/route';
import { PUT as destroyService } from 'src/app/api/v2/builds/[uuid]/services/[name]/destroy/route';
import { GET as getWebhooks, PUT as invokeWebhooks } from 'src/app/api/v2/builds/[uuid]/webhooks/route';
import { PATCH as patchServices } from 'src/app/api/v2/builds/[uuid]/services/route';
import { GET as getMetadata } from 'src/app/api/v2/builds/[uuid]/metadata/route';
import { GET as getBuildJob } from 'src/app/api/v2/builds/[uuid]/services/[name]/build-jobs/[jobName]/route';
import { GET as getDeployJob } from 'src/app/api/v2/builds/[uuid]/services/[name]/deploy-jobs/[jobName]/route';
import { ServiceOverrideNotEditableError, ServiceOverrideNotFoundError } from 'server/services/override';
import { BuildMetadataError } from 'server/services/buildMetadata';

const build = { id: 41, uuid: 'x', pullRequest: null, deploys: [] };
const buildContext = { params: Promise.resolve({ uuid: 'x' }) };
const serviceContext = { params: Promise.resolve({ uuid: 'x', name: 'web' }) };
const jobContext = { params: Promise.resolve({ uuid: 'x', name: 'web', jobName: 'job-1' }) };

const request = (path: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

function resolvedQuery(value: unknown) {
  const query: any = {
    findOne: jest.fn(() => query),
    whereNull: jest.fn(() => query),
    withGraphFetched: jest.fn().mockResolvedValue(value),
  };
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBuildByUUID.mockResolvedValue(build);
  mockRedeployBuild.mockResolvedValue({ status: 'success', message: 'queued' });
  mockDestroyBuildEnvironment.mockResolvedValue({ status: 'success', message: 'queued' });
  mockRedeployServiceFromBuild.mockResolvedValue({ status: 'success', message: 'queued' });
  mockDestroyServiceDeployment.mockResolvedValue({ status: 'success', message: 'queued' });
  mockGetWebhooksForBuild.mockResolvedValue({ status: 'success', data: [] });
  mockInvokeWebhooksForBuild.mockResolvedValue({ status: 'success', message: 'queued' });
  mockRenderMetadataForBuild.mockResolvedValue({ links: [] });
  mockGetLogStreamInfo.mockResolvedValue({ status: 'Complete', streamingRequired: false });
});

describe('legacy build UUID routes bind follow-up work to the authorized row', () => {
  it('fails closed when no live row exists instead of allowing a later UUID lookup', async () => {
    mockGetBuildByUUID.mockResolvedValue(null);

    const responses = [
      await redeployBuild(request('/api/v2/builds/x/redeploy', 'PUT'), buildContext),
      await destroyBuild(request('/api/v2/builds/x/destroy', 'PUT'), buildContext),
      await redeployService(request('/api/v2/builds/x/services/web/redeploy', 'PUT'), serviceContext),
      await destroyService(request('/api/v2/builds/x/services/web/destroy', 'PUT'), serviceContext),
      await getWebhooks(request('/api/v2/builds/x/webhooks', 'GET'), buildContext),
      await invokeWebhooks(request('/api/v2/builds/x/webhooks', 'PUT'), buildContext),
      await getMetadata(request('/api/v2/builds/x/metadata', 'GET'), buildContext),
      await getBuildJob(request('/api/v2/builds/x/services/web/build-jobs/job-1', 'GET'), jobContext),
      await getDeployJob(request('/api/v2/builds/x/services/web/deploy-jobs/job-1', 'GET'), jobContext),
    ];

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 404]);
    expect(mockRedeployBuild).not.toHaveBeenCalled();
    expect(mockDestroyBuildEnvironment).not.toHaveBeenCalled();
    expect(mockRedeployServiceFromBuild).not.toHaveBeenCalled();
    expect(mockDestroyServiceDeployment).not.toHaveBeenCalled();
    expect(mockGetWebhooksForBuild).not.toHaveBeenCalled();
    expect(mockInvokeWebhooksForBuild).not.toHaveBeenCalled();
    expect(mockRenderMetadataForBuild).not.toHaveBeenCalled();
    expect(mockGetLogStreamInfo).not.toHaveBeenCalled();
  });

  it('binds whole-build redeploy and destroy', async () => {
    await redeployBuild(request('/api/v2/builds/x/redeploy', 'PUT'), buildContext);
    await destroyBuild(request('/api/v2/builds/x/destroy', 'PUT'), buildContext);

    expect(mockRedeployBuild).toHaveBeenCalledWith('x', 41);
    expect(mockDestroyBuildEnvironment).toHaveBeenCalledWith('x', 41);
  });

  it('binds per-service redeploy and destroy', async () => {
    await redeployService(request('/api/v2/builds/x/services/web/redeploy', 'PUT'), serviceContext);
    await destroyService(request('/api/v2/builds/x/services/web/destroy', 'PUT'), serviceContext);

    expect(mockRedeployServiceFromBuild).toHaveBeenCalledWith('x', 'web', 41);
    expect(mockDestroyServiceDeployment).toHaveBeenCalledWith('x', 'web', 41);
  });

  it('binds webhook reads and invocations', async () => {
    await getWebhooks(request('/api/v2/builds/x/webhooks', 'GET'), buildContext);
    await invokeWebhooks(request('/api/v2/builds/x/webhooks', 'PUT'), buildContext);

    expect(mockGetWebhooksForBuild).toHaveBeenCalledWith('x', 41);
    expect(mockInvokeWebhooksForBuild).toHaveBeenCalledWith('x', 41);
  });

  it('renders metadata from the already-authorized build', async () => {
    await getMetadata(request('/api/v2/builds/x/metadata', 'GET'), buildContext);

    expect(mockRenderMetadataForBuild).toHaveBeenCalledWith(build);
  });

  it('binds build and deploy log lookups', async () => {
    await getBuildJob(request('/api/v2/builds/x/services/web/build-jobs/job-1', 'GET'), jobContext);
    await getDeployJob(request('/api/v2/builds/x/services/web/deploy-jobs/job-1', 'GET'), jobContext);

    expect(mockGetLogStreamInfo).toHaveBeenNthCalledWith(1, 'x', 'job-1', 'web', 'build', 41);
    expect(mockGetLogStreamInfo).toHaveBeenNthCalledWith(2, 'x', 'job-1', 'web', 'deploy', 41);
  });
});

describe('legacy build webhook response mapping', () => {
  it('returns the service webhook list', async () => {
    mockGetWebhooksForBuild.mockResolvedValue({
      status: 'success',
      data: [{ id: 7, status: 'completed' }],
    });

    const response = await getWebhooks(request('/api/v2/builds/x/webhooks', 'GET'), buildContext);

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([{ id: 7, status: 'completed' }]);
  });

  it('maps a missing webhook history to 404', async () => {
    mockGetWebhooksForBuild.mockResolvedValue({ status: 'not_found', message: 'Webhook history not found.' });

    const response = await getWebhooks(request('/api/v2/builds/x/webhooks', 'GET'), buildContext);

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe('An unknown error occurred.');
  });

  it.each([
    { serviceStatus: 'success', expectedStatus: 200, message: 'Webhooks queued.' },
    { serviceStatus: 'not_found', expectedStatus: 404, message: 'Webhook config not found.' },
    { serviceStatus: 'no_content', expectedStatus: 200, message: 'No webhooks configured.' },
    { serviceStatus: 'invalid', expectedStatus: 400, message: 'Webhook config is invalid.' },
  ])(
    'maps invoke status $serviceStatus to HTTP $expectedStatus',
    async ({ serviceStatus, expectedStatus, message }) => {
      mockInvokeWebhooksForBuild.mockResolvedValue({ status: serviceStatus, message });

      const response = await invokeWebhooks(request('/api/v2/builds/x/webhooks', 'PUT'), buildContext);
      const body = await response.json();

      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(body.data).toEqual({ status: serviceStatus, message });
      } else {
        expect(body.error.message).toBe('An unknown error occurred.');
      }
    }
  );
});

describe.each([
  {
    label: 'whole-build redeploy',
    invoke: () => redeployBuild(request('/api/v2/builds/x/redeploy', 'PUT'), buildContext),
    serviceMock: mockRedeployBuild,
  },
  {
    label: 'whole-build destroy',
    invoke: () => destroyBuild(request('/api/v2/builds/x/destroy', 'PUT'), buildContext),
    serviceMock: mockDestroyBuildEnvironment,
  },
  {
    label: 'service redeploy',
    invoke: () => redeployService(request('/api/v2/builds/x/services/web/redeploy', 'PUT'), serviceContext),
    serviceMock: mockRedeployServiceFromBuild,
  },
  {
    label: 'service destroy',
    invoke: () => destroyService(request('/api/v2/builds/x/services/web/destroy', 'PUT'), serviceContext),
    serviceMock: mockDestroyServiceDeployment,
  },
])('$label response mapping', ({ invoke, serviceMock }) => {
  it.each([
    { serviceStatus: 'success', expectedStatus: 200, message: 'Work queued.' },
    { serviceStatus: 'not_found', expectedStatus: 404, message: 'Target not found.' },
    { serviceStatus: 'invalid', expectedStatus: 400, message: 'Request cannot be completed.' },
  ])(
    'maps service status $serviceStatus to HTTP $expectedStatus',
    async ({ serviceStatus, expectedStatus, message }) => {
      serviceMock.mockResolvedValue({ status: serviceStatus, message });

      const response = await invoke();
      const body = await response.json();

      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(body.data).toEqual({ status: serviceStatus, message });
      } else {
        expect(body.error.message).toBe('An unknown error occurred.');
      }
    }
  );
});

describe('legacy build metadata response mapping', () => {
  it.each([
    { code: 'not_found', expectedStatus: 404, message: 'Rendered metadata target not found.' },
    { code: 'invalid_link', expectedStatus: 400, message: 'Rendered metadata link is invalid.' },
  ])('maps metadata error $code to HTTP $expectedStatus', async ({ code, expectedStatus, message }) => {
    mockRenderMetadataForBuild.mockRejectedValue(new BuildMetadataError(message, code));

    const response = await getMetadata(request('/api/v2/builds/x/metadata', 'GET'), buildContext);

    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error.message).toBe(message);
  });

  it('rethrows an unexpected renderer failure for the API wrapper', async () => {
    mockRenderMetadataForBuild.mockRejectedValue(new Error('metadata renderer unavailable'));

    await expect(getMetadata(request('/api/v2/builds/x/metadata', 'GET'), buildContext)).rejects.toThrow(
      'metadata renderer unavailable'
    );
  });
});

describe('legacy override routes keep liveness and exact-row identity through rehydration', () => {
  it('rejects contradictory duplicate service overrides before mutating a deploy', async () => {
    const response = await patchServices(
      request('/api/v2/builds/x/services', 'PATCH', {
        serviceOverrides: [
          { name: 'web', active: true },
          { name: 'web', active: false },
        ],
      }),
      buildContext
    );

    expect(response.status).toBe(400);
    expect(mockOverrideBuildQuery).not.toHaveBeenCalled();
    expect(mockApplyServiceOverrides).not.toHaveBeenCalled();
  });

  it('filters the build PATCH target to a live row and rehydrates the returned row by id', async () => {
    const initialQuery = resolvedQuery(build);
    mockOverrideBuildQuery.mockReturnValueOnce(initialQuery);
    mockApplyBuildConfigPatch.mockResolvedValue({ ...build, uuid: 'renamed' });
    mockGetBuildByUUID.mockResolvedValue({ ...build, uuid: 'renamed', isStatic: true });

    const response = await patchBuild(request('/api/v2/builds/x', 'PATCH', { isStatic: true }), buildContext);

    expect(response.status).toBe(200);
    expect(initialQuery.findOne).toHaveBeenCalledWith({ uuid: 'x' });
    expect(initialQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(mockGetBuildByUUID).toHaveBeenCalledWith('renamed', { liveOnly: true, expectedBuildId: 41 });
  });

  it('filters service PATCH to a live row and rehydrates that same id', async () => {
    const initialQuery = resolvedQuery(build);
    const updatedBuild = { ...build, deploys: [{ id: 5, deployable: { name: 'web' } }] };
    const rehydrateQuery = resolvedQuery(updatedBuild);
    mockOverrideBuildQuery.mockReturnValueOnce(initialQuery).mockReturnValueOnce(rehydrateQuery);
    mockApplyServiceOverrides.mockResolvedValue({ status: 'success', queued: true });
    mockGetServiceOverrideStates.mockResolvedValue([]);

    const response = await patchServices(
      request('/api/v2/builds/x/services', 'PATCH', { serviceOverrides: [{ name: 'web', active: false }] }),
      buildContext
    );

    expect(response.status).toBe(200);
    expect(initialQuery.findOne).toHaveBeenCalledWith({ uuid: 'x' });
    expect(initialQuery.whereNull).toHaveBeenCalledWith('deletedAt');
    expect(rehydrateQuery.findOne).toHaveBeenCalledWith({ uuid: 'x', id: 41 });
    expect(rehydrateQuery.whereNull).toHaveBeenCalledWith('deletedAt');
  });

  it.each([
    { label: 'a missing body', body: undefined, message: 'serviceOverrides must be a non-empty array' },
    { label: 'an omitted override list', body: {}, message: 'serviceOverrides must be a non-empty array' },
    {
      label: 'a null override list',
      body: { serviceOverrides: null },
      message: 'serviceOverrides must be a non-empty array',
    },
    {
      label: 'an empty override list',
      body: { serviceOverrides: [] },
      message: 'serviceOverrides must be a non-empty array',
    },
    {
      label: 'a null item',
      body: { serviceOverrides: [null] },
      message: 'serviceOverrides[0] must be an object',
    },
    {
      label: 'a primitive item',
      body: { serviceOverrides: ['web'] },
      message: 'serviceOverrides[0] must be an object',
    },
    {
      label: 'an array item',
      body: { serviceOverrides: [[]] },
      message: 'serviceOverrides[0] must be an object',
    },
    {
      label: 'a missing service name',
      body: { serviceOverrides: [{ active: true }] },
      message: 'serviceOverrides[0].name must be a non-empty string',
    },
    {
      label: 'an empty service name',
      body: { serviceOverrides: [{ name: '', active: true }] },
      message: 'serviceOverrides[0].name must be a non-empty string',
    },
    {
      label: 'no editable fields',
      body: { serviceOverrides: [{ name: 'web' }] },
      message: 'serviceOverrides[0] requires active or branchOrExternalUrl',
    },
    {
      label: 'a non-boolean active flag',
      body: { serviceOverrides: [{ name: 'web', active: 'true' }] },
      message: 'serviceOverrides[0].active must be a boolean',
    },
    {
      label: 'a non-string branch or URL',
      body: { serviceOverrides: [{ name: 'web', branchOrExternalUrl: 7 }] },
      message: 'serviceOverrides[0].branchOrExternalUrl must be a string',
    },
  ])('rejects $label before querying or mutating builds', async ({ body, message }) => {
    const response = await patchServices(request('/api/v2/builds/x/services', 'PATCH', body), buildContext);
    const responseBody = await response.json();

    expect(response.status).toBe(400);
    expect(responseBody.error.message).toBe(message);
    expect(mockOverrideBuildQuery).not.toHaveBeenCalled();
    expect(mockApplyServiceOverrides).not.toHaveBeenCalled();
  });

  it('accepts a branch-only override and defaults missing deploy collections to empty arrays', async () => {
    const initialBuild = { ...build, deploys: undefined };
    const updatedBuild = { ...build, deploys: undefined };
    mockOverrideBuildQuery
      .mockReturnValueOnce(resolvedQuery(initialBuild))
      .mockReturnValueOnce(resolvedQuery(updatedBuild));
    mockApplyServiceOverrides.mockResolvedValue({ status: 'success', queued: false });
    mockGetServiceOverrideStates.mockResolvedValue([
      { name: 'web', active: true, branchOrExternalUrl: 'https://preview.example.test' },
    ]);

    const response = await patchServices(
      request('/api/v2/builds/x/services', 'PATCH', {
        serviceOverrides: [{ name: 'web', branchOrExternalUrl: 'https://preview.example.test' }],
      }),
      buildContext
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockApplyServiceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({
        build: initialBuild,
        deploys: [],
        serviceOverrides: [{ name: 'web', branchOrExternalUrl: 'https://preview.example.test' }],
        runUuid: expect.any(String),
      })
    );
    expect(mockGetServiceOverrideStates).toHaveBeenCalledWith([]);
    expect(body.data).toEqual({
      serviceOverrides: [{ name: 'web', active: true, branchOrExternalUrl: 'https://preview.example.test' }],
      queued: false,
    });
  });

  it('returns 404 before authorization or mutation when the live build row is missing', async () => {
    mockOverrideBuildQuery.mockReturnValueOnce(resolvedQuery(null));

    const response = await patchServices(
      request('/api/v2/builds/missing/services', 'PATCH', {
        serviceOverrides: [{ name: 'web', active: true }],
      }),
      { params: Promise.resolve({ uuid: 'missing' }) }
    );

    expect(response.status).toBe(404);
    expect(mockApplyServiceOverrides).not.toHaveBeenCalled();
    expect(mockGetServiceOverrideStates).not.toHaveBeenCalled();
  });

  it('returns 404 if the authorized build disappears before response rehydration', async () => {
    mockOverrideBuildQuery.mockReturnValueOnce(resolvedQuery(build)).mockReturnValueOnce(resolvedQuery(null));
    mockApplyServiceOverrides.mockResolvedValue({ status: 'success', queued: true });

    const response = await patchServices(
      request('/api/v2/builds/x/services', 'PATCH', {
        serviceOverrides: [{ name: 'web', active: false }],
      }),
      buildContext
    );

    expect(response.status).toBe(404);
    expect(mockGetServiceOverrideStates).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a missing service',
      error: () => new ServiceOverrideNotFoundError('Service not found'),
      status: 404,
    },
    {
      label: 'a non-editable service',
      error: () => new ServiceOverrideNotEditableError('Service is not editable'),
      status: 400,
    },
  ])('maps $label from the override service', async ({ error, status }) => {
    mockOverrideBuildQuery.mockReturnValueOnce(resolvedQuery(build));
    mockApplyServiceOverrides.mockRejectedValueOnce(error());

    const response = await patchServices(
      request('/api/v2/builds/x/services', 'PATCH', {
        serviceOverrides: [{ name: 'web', active: false }],
      }),
      buildContext
    );

    expect(response.status).toBe(status);
    expect(mockGetServiceOverrideStates).not.toHaveBeenCalled();
  });

  it('rethrows unexpected override failures for the API wrapper to map to 500', async () => {
    const failure = new Error('database unavailable');
    mockOverrideBuildQuery.mockReturnValueOnce(resolvedQuery(build));
    mockApplyServiceOverrides.mockRejectedValueOnce(failure);

    await expect(
      patchServices(
        request('/api/v2/builds/x/services', 'PATCH', {
          serviceOverrides: [{ name: 'web', active: false }],
        }),
        buildContext
      )
    ).rejects.toBe(failure);
  });
});
