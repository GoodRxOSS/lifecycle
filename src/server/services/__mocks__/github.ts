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

import { NextApiRequest } from 'next';
import Redis from 'ioredis';
import Redlock from 'redlock';
import * as models from 'server/models';
import { IServices } from 'server/services/types';
import Database from 'server/database';

/**
 * Database Service Mock
 */

export const mockDatabaseService = jest.fn().mockImplementation(() => ({
  __knexInstance: {} as unknown,
  knexConfig: {} as unknown,
  models: {} as Partial<models.IModels>,
  services: {} as Partial<IServices>,
  setKnexConfig: jest.fn(),
  connect: jest.fn(),
  close: jest.fn(),
})) as unknown as jest.Mocked<Database>;

export const mockRedis = jest.fn() as unknown as jest.Mocked<Redis.Redis>;
export const mockRedlock = jest.fn() as unknown as jest.Mocked<Redlock>;

/**
 * Github Service Function Mocks
 */
export const mockHandlePullRequestHook = jest.fn();
export const mockHandleIssueCommentWebhook = jest.fn();
export const mockHandleLabelWebhook = jest.fn();
export const mockHandleInstallationWebhook = jest.fn();
export const mockHandlePushWebhook = jest.fn();
export const mockDispatchWebhook = jest.fn();
export const mockWebhookQueue = jest.fn();
export const mockProcessWebhooks = jest.fn();

export const mockFindOne = jest.fn();

/**
 * Build Model Mock
 */
export const mockBuildModel = {
  findOne: mockFindOne,
};

/**
 * Deploy Model Mock
 */
const mockWhere = jest.fn().mockReturnThis();
const mockWithGraphFetched = jest.fn().mockReturnThis();
const mockQuery = jest.fn(() => ({ where: mockWhere, withGraphFetched: mockWithGraphFetched }));
export const mockDeployModel = {
  query: mockQuery,
};

/**
 * Pullrequest Model Mock
 */
export const mockPullRequestModel$FetchGraph = jest.fn();
export const mockPullRequestModel$Query = jest.fn().mockImplementation(() => ({
  patch: mockPatch,
}));
export const mockPullRequestModelFindOne = jest.fn().mockImplementation(() => ({
  $fetchGraph: mockPullRequestModel$FetchGraph,
  $query: mockPullRequestModel$Query,
}));
export const mockPullRequestModel = {
  findOne: mockPullRequestModelFindOne,
};

/**
 * ActivityStream Service Mock
 */
const mockUpdateBuildsAndDeploysFromCommentEdit = jest.fn();
const mockActivityStreamService = {
  updateBuildsAndDeploysFromCommentEdit: mockUpdateBuildsAndDeploysFromCommentEdit,
};

/**
 * Bot User Service Mock
 */
export const mockIsBotUser = jest.fn();
export const mockBotUserService = {
  isBotUser: mockIsBotUser,
};

/**
 * Build Service Mock
 */
export const mockCreateAndOptionallyDeployFromGithub = jest.fn();
export const mockDeleteBuild = jest.fn();
export const mockResolveAndDeployBuildQueueAdd = jest.fn();
export const mockBuildService = {
  findOne: mockFindOne,
  createAndOptionallyDeployFromGithub: mockCreateAndOptionallyDeployFromGithub,
  deleteBuild: mockDeleteBuild,
  resolveAndDeployBuildQueue: {
    add: mockResolveAndDeployBuildQueueAdd,
  },
};

/**
 * Environment Service Mock
 */
export const mockFindOrCreateEnvironment = jest.fn();
export const mockEnvironmentService = {
  findOrCreateEnvironment: mockFindOrCreateEnvironment,
};

/**
 * PullRequest Service Mock
 */
export const mockPatch = jest.fn();
export const mock$Query = jest.fn().mockImplementation(() => ({
  patch: mockPatch,
}));
export const mockFindOrCreatePullRequest = jest.fn().mockImplementation(() => ({
  $query: mock$Query,
}));

export const mockPullRequestService = {
  findOrCreatePullRequest: mockFindOrCreatePullRequest,
};

/**
 * Repository Service Mock
 */
export const mockFindRepository = jest.fn();
export const mockFindOrCreateRepository = jest.fn();
export const mockRepositoryService = {
  findRepository: mockFindRepository,
  findOrCreateRepository: mockFindOrCreateRepository,
};

export const mockModels = {
  Build: mockBuildModel,
  Deploy: mockDeployModel,
  PullRequest: mockPullRequestModel,
};
export const mockServices = {
  ActivityStream: mockActivityStreamService,
  BotUser: mockBotUserService,
  Build: mockBuildService,
  Environment: mockEnvironmentService,
  PullRequest: mockPullRequestService,
  Repository: mockRepositoryService,
};

export const mockDb = {
  models: mockModels,
  services: mockServices,
};

export const mockSetUpYamlSupport = jest.fn();
export const mockResolveLabel = jest.fn();
export const mockConstructPullRequestData = jest.fn();
export const mockComputeDeployOnUpdate = jest.fn();
export const mockDetermineIfBuildIsNeeded = jest.fn();
export const mockGetDeploys = jest.fn();
export const mockDetermineIfBuildShouldBeDeployed = jest.fn();
const mockGithubService = jest.fn().mockImplementation(() => ({
  // mock utils
  setUpYamlSupport: mockSetUpYamlSupport,
  computeDeployOnUpdate: mockComputeDeployOnUpdate,
  constructPullRequestData: mockConstructPullRequestData,
  determineIfBuildIsNeeded: mockDetermineIfBuildIsNeeded,
  determineIfBuildShouldBeDeployed: mockDetermineIfBuildShouldBeDeployed,
  getDeploys: mockGetDeploys,
  resolveLabel: mockResolveLabel,
  // mock methods
  handlePullRequestHook: mockHandlePullRequestHook,
  handleIssueCommentWebhook: mockHandleIssueCommentWebhook,
  handleLabelWebhook: mockHandleLabelWebhook,
  handleInstallationWebhook: mockHandleInstallationWebhook,
  handlePushWebhook: mockHandlePushWebhook,
  dispatchWebhook: mockDispatchWebhook,
  webhookQueue: mockWebhookQueue,
  processWebhooks: mockProcessWebhooks,
  // mock services
  db: {
    models: mockModels,
    services: mockServices,
  },
}));

export const Github = mockGithubService;

export const mockLoggerError = jest.fn();
export const mockLoggerDebug = jest.fn();
export const mockLogger = {
  debug: mockLoggerDebug,
  error: mockLoggerError,
};

/**
 * Github Mock Helper Functions
 */
export const mockNextApiRequest = (action: string, eventType: string) =>
  ({
    body: { action },
    headers: { 'x-github-event': eventType },
  } as unknown as NextApiRequest);

export const mockJob = (action: string, eventType: string) => ({
  data: {
    message: {
      body: { action },
      headers: { 'x-github-event': eventType },
    },
  },
});

export const mockBuild$Query = jest.fn().mockImplementation(() => ({
  patch: mockPatch,
}));

export const mockDeploy$Query = jest.fn().mockImplementation(() => ({
  patch: mockPatch,
}));

export const mockDeploy = (name = 'test') => ({
  deployable: {
    name,
  },
  service: {
    name,
  },
});

export const mockPullrequestBuildResponse = () => ({
  build: {
    $query: mockBuild$Query,
    id: 123,
    uuid: 'abc123',
    deploys: [mockDeploy()],
  },
  deployOnUpdate: true,
});

export default mockGithubService;
