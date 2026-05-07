/**
 * Copyright 2026 Lifecycle contributors
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

const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
const mockApplyBuildOverrides = jest.fn();
const mockRegisterQueue = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
  redisClient: {
    getConnection: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
  withLogContext: jest.fn((_context, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  LogStage: {},
}));

jest.mock('shared/config', () => ({
  LIFECYCLE_UI_URL: 'https://lifecycle.example.com',
  QUEUE_NAMES: {
    COMMENT_QUEUE: 'comment',
  },
}));

jest.mock('server/lib/fastly', () =>
  jest.fn().mockImplementation(() => ({
    getServiceDashboardUrl: jest.fn(),
    purgeService: jest.fn(),
  }))
);

jest.mock('server/lib/metrics', () => ({
  Metrics: jest.fn().mockImplementation(() => ({
    increment: jest.fn().mockReturnThis(),
    event: jest.fn().mockReturnThis(),
  })),
}));

jest.mock('server/lib/nativeHelm', () => ({
  ChartType: {},
  determineChartType: jest.fn(),
}));

jest.mock('server/lib/utils', () => ({
  enableKillSwitch: jest.fn(),
  flattenObject: jest.fn((value) => value),
  getDeployLabel: jest.fn().mockResolvedValue('lifecycle-deploy!'),
  getDisabledLabel: jest.fn().mockResolvedValue('lifecycle-disabled!'),
  getStatusCommentLabel: jest.fn().mockResolvedValue('lifecycle-status-comments!'),
  hasDeployLabel: jest.fn().mockResolvedValue(false),
  hasStatusCommentLabel: jest.fn().mockResolvedValue(false),
  isControlCommentsEnabled: jest.fn().mockResolvedValue(true),
  isDefaultStatusCommentsEnabled: jest.fn().mockResolvedValue(false),
  isStaging: jest.fn(() => false),
}));

jest.mock('server/lib/github', () => ({
  checkIfCommentExists: jest.fn(),
  createOrUpdatePullRequestComment: jest.fn(),
}));

jest.mock('server/lib/kubernetes', () => ({
  deleteNamespace: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    hostForDeployableDeploy: jest.fn(),
    hostForServiceDeploy: jest.fn(),
  })),
}));

jest.mock('server/services/buildMetadata', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../override', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    applyBuildOverrides: (...args: unknown[]) => mockApplyBuildOverrides(...args),
  })),
}));

import ActivityStream from '../activityStream';
import { CommentParser } from 'shared/constants';

function createActivityStream() {
  mockRegisterQueue.mockReturnValue({
    add: jest.fn(),
  });

  const db = {
    services: {
      Deploy: {
        hostForDeployableDeploy: jest.fn(),
        hostForServiceDeploy: jest.fn(),
      },
    },
  };

  return new ActivityStream(
    db as any,
    {} as any,
    {} as any,
    {
      registerQueue: mockRegisterQueue,
    } as any
  );
}

describe('ActivityStream comment overrides', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('parses comment overrides and delegates structured updates to OverrideService', async () => {
    const service = createActivityStream();
    const build = {
      id: 42,
      uuid: 'current-build',
    };
    const deploys = [{ id: 1 }];
    const pullRequest = {
      deployOnUpdate: true,
    };
    const commentBody = [
      CommentParser.HEADER,
      '- [x] api: feature/api',
      '- [ ] cache: main',
      'url: new-build',
      'ENV:FEATURE_ENABLED:true',
      CommentParser.FOOTER,
      '- [x] Redeploy on pushes to default branches',
    ].join('\n');

    await (service as any).applyCommentOverrides({
      build,
      deploys,
      pullRequest,
      commentBody,
      runUuid: 'run-uuid',
    });

    expect(mockApplyBuildOverrides).toHaveBeenCalledWith({
      build,
      deploys,
      pullRequest,
      runUuid: 'run-uuid',
      overrides: {
        serviceOverrides: [
          {
            active: true,
            serviceName: 'api',
            branchOrExternalUrl: 'feature/api',
          },
          {
            active: false,
            serviceName: 'cache',
            branchOrExternalUrl: 'main',
          },
        ],
        vanityUrl: 'new-build',
        envOverrides: {
          FEATURE_ENABLED: 'true',
        },
        redeployOnPush: true,
      },
    });
  });

  it('does not delegate when build id is missing', async () => {
    const service = createActivityStream();
    const commentBody = [CommentParser.HEADER, '- [x] api: feature/api', CommentParser.FOOTER].join('\n');

    await (service as any).applyCommentOverrides({
      build: {
        uuid: 'current-build',
      },
      deploys: [],
      pullRequest: {},
      commentBody,
      runUuid: 'run-uuid',
    });

    expect(mockApplyBuildOverrides).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith('Build: missing for comment edit overrides');
  });
});
