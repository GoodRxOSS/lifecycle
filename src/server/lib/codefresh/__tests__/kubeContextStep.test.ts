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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

// Mock the GlobalConfigService before importing
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(),
  },
}));

// Mock shared/config before importing
jest.mock('shared/config', () => ({
  ENVIRONMENT: 'production',
}));

import { kubeContextStep } from 'server/lib/codefresh';
import GlobalConfigService from 'server/services/globalConfig';

const MockedGlobalConfigService = GlobalConfigService as jest.MockedClass<typeof GlobalConfigService>;

describe('kubeContextStep', () => {
  let mockGetAllConfigs: jest.Mock;
  let mockInstance: Partial<GlobalConfigService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockGetAllConfigs = jest.fn();
    mockInstance = {
      getAllConfigs: mockGetAllConfigs,
    };

    (MockedGlobalConfigService.getInstance as jest.Mock).mockReturnValue(mockInstance);
  });

  describe('gitOrg handling', () => {
    const context = 'test-context';
    const cluster = 'test-cluster';

    it('should use the org value when app_setup.org is a valid string', async () => {
      mockGetAllConfigs.mockResolvedValue({
        app_setup: { org: 'test-org' },
      });

      const result = await kubeContextStep({ context, cluster });

      expect(result).toEqual({
        title: 'Set kube context',
        type: 'test-org/kube-context:0.0.2',
        arguments: {
          app: context,
          cluster,
          aws_access_key_id: '${{DEPLOYMENT_AWS_ACCESS_KEY_ID}}',
          aws_secret_access_key: '${{DEPLOYMENT_AWS_SECRET_ACCESS_KEY}}',
        },
      });
    });

    it('should use fallback when app_setup does not exist', async () => {
      mockGetAllConfigs.mockResolvedValue({});

      const result = await kubeContextStep({ context, cluster });

      expect(result.type).toBe('REPLACE_ME_ORG/kube-context:0.0.2');
    });

    it('should use fallback when app_setup.org is undefined', async () => {
      mockGetAllConfigs.mockResolvedValue({
        app_setup: {},
      });

      const result = await kubeContextStep({ context, cluster });

      expect(result.type).toBe('REPLACE_ME_ORG/kube-context:0.0.2');
    });

    it('should use fallback when app_setup.org is an empty string', async () => {
      mockGetAllConfigs.mockResolvedValue({
        app_setup: { org: '' },
      });

      const result = await kubeContextStep({ context, cluster });

      expect(result.type).toBe('REPLACE_ME_ORG/kube-context:0.0.2');
    });

    it('should use fallback when app_setup.org is whitespace only', async () => {
      mockGetAllConfigs.mockResolvedValue({
        app_setup: { org: '   ' },
      });

      const result = await kubeContextStep({ context, cluster });

      expect(result.type).toBe('REPLACE_ME_ORG/kube-context:0.0.2');
    });

    it('should trim whitespace from valid org values', async () => {
      mockGetAllConfigs.mockResolvedValue({
        app_setup: { org: '  test-org  ' },
      });

      const result = await kubeContextStep({ context, cluster });

      expect(result.type).toBe('test-org/kube-context:0.0.2');
    });
  });
});
