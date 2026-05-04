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

import {
  assertNoHelmSecretValueRefs,
  buildHelmSecretVolumeMounts,
  buildHelmSecretVolumes,
  generateHelmSecretKey,
  HELM_SECRET_MOUNT_ROOT,
  splitHelmSecretValueRefs,
} from 'server/lib/helm/secretValueRefs';

describe('helm secret value refs', () => {
  it('detects full-value Helm secret refs and creates stable set-file metadata', () => {
    const result = splitHelmSecretValueRefs(
      ['auth.password={{aws:repo/example/database:POSTGRES_PASSWORD}}'],
      'example-db'
    );

    expect(result.plainValues).toEqual([]);
    expect(result.secretRefs).toEqual([
      {
        envKey: generateHelmSecretKey('auth.password', {
          provider: 'aws',
          path: 'repo/example/database',
          key: 'POSTGRES_PASSWORD',
        }),
        helmKey: 'auth.password',
        provider: 'aws',
        path: 'repo/example/database',
        key: 'POSTGRES_PASSWORD',
      },
    ]);
    expect(result.secretSetFiles).toEqual([
      {
        helmKey: 'auth.password',
        secretName: 'example-db-aws-secrets',
        secretKey: result.secretRefs[0].envKey,
        provider: 'aws',
        mountPath: `${HELM_SECRET_MOUNT_ROOT}/example-db-aws-secrets/${result.secretRefs[0].envKey}`,
      },
    ]);
  });

  it('preserves plain Helm values', () => {
    const result = splitHelmSecretValueRefs(['auth.database=app_db'], 'example-db');

    expect(result.plainValues).toEqual(['auth.database=app_db']);
    expect(result.secretRefs).toEqual([]);
    expect(result.secretSetFiles).toEqual([]);
  });

  it('rejects partial secret interpolation', () => {
    expect(() =>
      splitHelmSecretValueRefs(
        ['auth.url=postgres://user:{{aws:repo/example/database:POSTGRES_PASSWORD}}@host/db'],
        'example-db'
      )
    ).toThrow("Helm custom value 'auth.url' uses unsupported partial or malformed secret interpolation");
  });

  it('rejects unsupported secret refs on Codefresh deploy paths', () => {
    expect(() =>
      assertNoHelmSecretValueRefs(
        ['auth.password={{aws:repo/example/database:POSTGRES_PASSWORD}}'],
        'Codefresh Helm deploy path'
      )
    ).toThrow('Codefresh Helm deploy path does not support helm.chart.values secret refs');
  });

  it('builds secret volumes and mounts for only the required Helm keys', () => {
    const result = splitHelmSecretValueRefs(
      [
        'auth.username={{aws:repo/example/database:POSTGRES_USER}}',
        'auth.password={{aws:repo/example/database:POSTGRES_PASSWORD}}',
      ],
      'example-db'
    );

    expect(buildHelmSecretVolumes(result.secretSetFiles)).toEqual([
      {
        name: expect.stringMatching(/^helm-secret-example-db-aws-secrets-[a-f0-9]{8}$/),
        secret: {
          secretName: 'example-db-aws-secrets',
          items: result.secretRefs.map((ref) => ({ key: ref.envKey, path: ref.envKey })),
        },
      },
    ]);
    expect(buildHelmSecretVolumeMounts(result.secretSetFiles)).toEqual([
      {
        name: expect.stringMatching(/^helm-secret-example-db-aws-secrets-[a-f0-9]{8}$/),
        mountPath: `${HELM_SECRET_MOUNT_ROOT}/example-db-aws-secrets`,
        readOnly: true,
      },
    ]);
  });
});
