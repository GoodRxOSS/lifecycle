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

const mockCreateSecret = jest.fn();
const mockDeleteSecret = jest.fn();
const mockGetAccessToken = jest.fn();
const mockWarn = jest.fn();

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        createNamespacedSecret: mockCreateSecret,
        deleteNamespacedSecret: mockDeleteSecret,
      }),
    })),
  };
});

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getAccessToken: mockGetAccessToken,
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: mockWarn,
  }),
}));

import {
  buildGarDockerConfig,
  buildNativeBuildRegistryAuthSecretName,
  createNativeBuildRegistryAuthSecret,
  deleteNativeBuildRegistryAuthSecret,
  getKanikoInsecureRegistries,
  normalizeNativeBuildRegistryAuth,
} from '../registryAuth';

describe('native build registry auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccessToken.mockResolvedValue('gar-access-token');
    mockCreateSecret.mockResolvedValue({ body: {} });
    mockDeleteSecret.mockResolvedValue({});
  });

  describe('normalizeNativeBuildRegistryAuth', () => {
    it('keeps missing and empty registry authentication as a no-op', () => {
      expect(normalizeNativeBuildRegistryAuth(undefined)).toEqual([]);
      expect(normalizeNativeBuildRegistryAuth([])).toEqual([]);
    });

    it('normalizes GAR registry hostnames', () => {
      expect(
        normalizeNativeBuildRegistryAuth([
          {
            type: 'gar',
            registry: '  US-CENTRAL1-DOCKER.PKG.DEV  ',
          },
        ])
      ).toEqual([
        {
          type: 'gar',
          registry: 'us-central1-docker.pkg.dev',
        },
      ]);
    });

    it.each([
      ['non-array registryAuth', { type: 'gar', registry: 'us-central1-docker.pkg.dev' }],
      ['non-object entry', ['gar']],
      ['unsupported provider', [{ type: 'ecr', registry: '123456789.dkr.ecr.us-east-1.amazonaws.com' }]],
      ['registry path', [{ type: 'gar', registry: 'us-central1-docker.pkg.dev/project/repo' }]],
      ['registry scheme', [{ type: 'gar', registry: 'https://us-central1-docker.pkg.dev' }]],
      [
        'duplicate normalized registry',
        [
          { type: 'gar', registry: 'us-central1-docker.pkg.dev' },
          { type: 'gar', registry: ' US-CENTRAL1-DOCKER.PKG.DEV ' },
        ],
      ],
    ])('rejects %s', (_name, value) => {
      expect(() => normalizeNativeBuildRegistryAuth(value)).toThrow('Build:');
    });
  });

  describe('buildGarDockerConfig', () => {
    it('creates Docker credentials for each GAR host using one OAuth token', () => {
      const dockerConfig = JSON.parse(
        buildGarDockerConfig(
          [
            { type: 'gar', registry: 'us-central1-docker.pkg.dev' },
            { type: 'gar', registry: 'us-east1-docker.pkg.dev' },
          ],
          'gar-access-token'
        )
      );
      const expectedAuth = Buffer.from('oauth2accesstoken:gar-access-token').toString('base64');

      expect(dockerConfig).toEqual({
        auths: {
          'us-central1-docker.pkg.dev': { auth: expectedAuth },
          'us-east1-docker.pkg.dev': { auth: expectedAuth },
        },
      });
    });
  });

  describe('buildNativeBuildRegistryAuthSecretName', () => {
    it('derives a valid secret name while preserving the unique job suffix', () => {
      const secretName = buildNativeBuildRegistryAuthSecretName({
        deployUuid: 'subs-process-cancellations-solitary-glitter-950234',
        jobId: 'a1b2c',
        shortSha: '0d84142',
      });

      expect(secretName).toMatch(/-build-a1b2c-0d84142-registry-auth$/);
      expect(secretName.length).toBeLessThanOrEqual(63);
    });
  });

  describe('getKanikoInsecureRegistries', () => {
    it('keeps Distribution insecure while leaving GAR and ECR on HTTPS', () => {
      expect(
        getKanikoInsecureRegistries(
          [
            'registry.internal.svc.cluster.local/repo:tag',
            'us-central1-docker.pkg.dev/project/repo/cache',
            '123456789.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
          ],
          [{ type: 'gar', registry: 'us-central1-docker.pkg.dev' }]
        )
      ).toEqual(['registry.internal.svc.cluster.local']);
    });
  });

  describe('createNativeBuildRegistryAuthSecret', () => {
    it('stores GAR credentials in a temporary dockerconfigjson Secret', async () => {
      await createNativeBuildRegistryAuthSecret({
        namespace: 'env-test-123',
        secretName: 'test-build-registry-auth',
        registryAuth: [{ type: 'gar', registry: 'us-central1-docker.pkg.dev' }],
        buildUuid: 'build-123',
        deployUuid: 'deploy-123',
      });

      expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
      expect(mockCreateSecret).toHaveBeenCalledWith(
        'env-test-123',
        expect.objectContaining({
          metadata: {
            name: 'test-build-registry-auth',
            namespace: 'env-test-123',
            labels: {
              'app.kubernetes.io/managed-by': 'lifecycle',
              'app.kubernetes.io/component': 'native-build-registry-auth',
              lc_uuid: 'build-123',
              deploy_uuid: 'deploy-123',
            },
          },
          type: 'kubernetes.io/dockerconfigjson',
          stringData: {
            '.dockerconfigjson': buildGarDockerConfig(
              [{ type: 'gar', registry: 'us-central1-docker.pkg.dev' }],
              'gar-access-token'
            ),
          },
        })
      );
    });

    it('fails closed when ADC does not return a token', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      await expect(
        createNativeBuildRegistryAuthSecret({
          namespace: 'env-test-123',
          secretName: 'test-build-registry-auth',
          registryAuth: [{ type: 'gar', registry: 'us-central1-docker.pkg.dev' }],
          deployUuid: 'deploy-123',
        })
      ).rejects.toThrow(
        'Build: GAR access token acquisition failed registries=us-central1-docker.pkg.dev verify=google_application_default_credentials'
      );
      expect(mockCreateSecret).not.toHaveBeenCalled();
    });

    it('fails closed without exposing credentials when Secret creation fails', async () => {
      mockCreateSecret.mockRejectedValue(new Error('gar-access-token'));

      await expect(
        createNativeBuildRegistryAuthSecret({
          namespace: 'env-test-123',
          secretName: 'test-build-registry-auth',
          registryAuth: [{ type: 'gar', registry: 'us-central1-docker.pkg.dev' }],
          deployUuid: 'deploy-123',
        })
      ).rejects.toThrow(
        'Build: registry auth Secret creation failed secretName=test-build-registry-auth namespace=env-test-123'
      );
    });
  });

  describe('deleteNativeBuildRegistryAuthSecret', () => {
    it('does not fail the build when Secret cleanup fails', async () => {
      mockDeleteSecret.mockRejectedValue(new Error('cleanup failed'));

      await expect(deleteNativeBuildRegistryAuthSecret('env-test-123', 'test-build-registry-auth')).resolves.toBe(
        undefined
      );
      expect(mockWarn).toHaveBeenCalledWith(
        'Build: registry auth cleanup failed secretName=test-build-registry-auth namespace=env-test-123'
      );
    });
  });
});
