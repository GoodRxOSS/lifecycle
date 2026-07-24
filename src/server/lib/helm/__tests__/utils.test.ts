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

import { NodeAffinity, Toleration } from 'server/lib/helm/types';
import { generateTolerationsCustomValues, generateNodeAffinityCustomValues } from 'server/lib/helm/utils';

jest.mock('server/lib/envVariables', () => ({
  EnvironmentVariables: class {},
}));

describe('generateTolerationsCustomValues', () => {
  it('should generate custom values for tolerations', () => {
    const key = 'tolerations';
    const tolerations: Toleration[] = [
      {
        key: 'static_env',
        operator: 'Equal',
        value: 'yes',
        effect: 'NoSchedule',
      },
    ];
    const expectedCustomValues: string[] = [
      'tolerations[0].key=static_env',
      'tolerations[0].operator=Equal',
      'tolerations[0].value=yes',
      'tolerations[0].effect=NoSchedule',
    ];

    const customValues = generateTolerationsCustomValues(key, tolerations);

    expect(customValues).toEqual(expectedCustomValues);
  });
});

describe('generateNodeAffinityCustomValues', () => {
  it('should generate custom values for node affinity', () => {
    const key = 'spec.affinity';
    const nodeAffinity: NodeAffinity = {
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          matchExpressions: [
            {
              key: 'app-long',
              operator: 'In',
              values: ['lifecycle-static-env'],
            },
          ],
        },
      ],
    };
    const expectedCustomValues: string[] = [
      'spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=app-long',
      'spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=In',
      'spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=lifecycle-static-env',
    ];

    const customValues = generateNodeAffinityCustomValues(key, nodeAffinity);

    expect(customValues).toEqual(expectedCustomValues);
  });
});
