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

const mockBuildService = jest.fn(() => ({ service: 'BuildService' }));
const mockEnvironment = jest.fn(() => ({ service: 'Environment' }));
const mockGithubService = jest.fn(() => ({ service: 'GithubService' }));
const mockPullRequest = jest.fn(() => ({ service: 'PullRequest' }));
const mockRepository = jest.fn(() => ({ service: 'Repository' }));
const mockDeploy = jest.fn(() => ({ service: 'Deploy' }));
const mockActivityStream = jest.fn(() => ({ service: 'ActivityStream' }));
const mockCodefresh = jest.fn(() => ({ service: 'Codefresh' }));
const mockWebhook = jest.fn(() => ({ service: 'Webhook' }));
const mockIngress = jest.fn(() => ({ service: 'Ingress' }));
const mockDeployable = jest.fn(() => ({ service: 'Deployable' }));
const mockBotUser = jest.fn(() => ({ service: 'BotUser' }));
const mockLabelService = jest.fn(() => ({ service: 'LabelService' }));
const mockTtlCleanupService = jest.fn(() => ({ service: 'TTLCleanupService' }));
const mockDeployCleanupService = jest.fn(() => ({ service: 'DeployCleanupService' }));
const mockSitesService = jest.fn(() => ({ service: 'SitesService' }));
const mockTelemetryService = jest.fn(() => ({ service: 'TelemetryService' }));
const mockGlobalConfig = { service: 'GlobalConfig' };
const mockGetGlobalConfigInstance = jest.fn(() => mockGlobalConfig);

jest.mock('server/services/build', () => ({ __esModule: true, default: mockBuildService }));
jest.mock('server/services/environment', () => ({ __esModule: true, default: mockEnvironment }));
jest.mock('server/services/github', () => ({ __esModule: true, default: mockGithubService }));
jest.mock('server/services/pullRequest', () => ({ __esModule: true, default: mockPullRequest }));
jest.mock('server/services/repository', () => ({ __esModule: true, default: mockRepository }));
jest.mock('server/services/deploy', () => ({ __esModule: true, default: mockDeploy }));
jest.mock('server/services/activityStream', () => ({ __esModule: true, default: mockActivityStream }));
jest.mock('server/services/codefresh', () => ({ __esModule: true, default: mockCodefresh }));
jest.mock('server/services/webhook', () => ({ __esModule: true, default: mockWebhook }));
jest.mock('server/services/ingress', () => ({ __esModule: true, default: mockIngress }));
jest.mock('server/services/deployable', () => ({ __esModule: true, default: mockDeployable }));
jest.mock('server/services/botUser', () => ({ __esModule: true, default: mockBotUser }));
jest.mock('server/services/label', () => ({ __esModule: true, default: mockLabelService }));
jest.mock('server/services/ttlCleanup', () => ({ __esModule: true, default: mockTtlCleanupService }));
jest.mock('server/services/deployCleanup', () => ({ __esModule: true, default: mockDeployCleanupService }));
jest.mock('server/services/sites', () => ({ __esModule: true, default: mockSitesService }));
jest.mock('server/services/telemetry', () => ({ __esModule: true, default: mockTelemetryService }));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: mockGetGlobalConfigInstance },
}));

const { default: createAndBindServices } = require('server/services') as typeof import('server/services');

const transientServiceConstructors = [
  mockBuildService,
  mockEnvironment,
  mockGithubService,
  mockPullRequest,
  mockRepository,
  mockDeploy,
  mockActivityStream,
  mockCodefresh,
  mockWebhook,
  mockIngress,
  mockDeployable,
  mockBotUser,
  mockLabelService,
  mockTtlCleanupService,
  mockDeployCleanupService,
  mockSitesService,
  mockTelemetryService,
];

describe('createAndBindServices', () => {
  it('binds every service under its public key and preserves the GlobalConfig singleton', () => {
    const services = createAndBindServices();

    expect(services).toEqual({
      BuildService: { service: 'BuildService' },
      Environment: { service: 'Environment' },
      GithubService: { service: 'GithubService' },
      PullRequest: { service: 'PullRequest' },
      Repository: { service: 'Repository' },
      Deploy: { service: 'Deploy' },
      ActivityStream: { service: 'ActivityStream' },
      Webhook: { service: 'Webhook' },
      Codefresh: { service: 'Codefresh' },
      Ingress: { service: 'Ingress' },
      Deployable: { service: 'Deployable' },
      BotUser: { service: 'BotUser' },
      GlobalConfig: mockGlobalConfig,
      LabelService: { service: 'LabelService' },
      TTLCleanupService: { service: 'TTLCleanupService' },
      DeployCleanupService: { service: 'DeployCleanupService' },
      SitesService: { service: 'SitesService' },
      TelemetryService: { service: 'TelemetryService' },
    });
    for (const constructor of transientServiceConstructors) {
      expect(constructor).toHaveBeenCalledTimes(1);
      expect(constructor).toHaveBeenCalledWith();
    }
    expect(mockGetGlobalConfigInstance).toHaveBeenCalledTimes(1);
  });

  it('creates fresh request-scoped services on each binding while reusing GlobalConfig', () => {
    const first = createAndBindServices();
    const second = createAndBindServices();

    for (const key of Object.keys(first) as Array<keyof typeof first>) {
      if (key === 'GlobalConfig') {
        expect(second[key]).toBe(first[key]);
      } else {
        expect(second[key]).not.toBe(first[key]);
      }
    }
  });
});
