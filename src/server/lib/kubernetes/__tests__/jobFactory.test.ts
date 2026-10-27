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

import { createHelmJob } from '../jobFactory';

describe('createHelmJob', () => {
  it('marks the deploy pod as not safe to evict by the cluster autoscaler', () => {
    const job = createHelmJob({
      name: 'helm-deploy-api',
      namespace: 'preview-123',
      serviceAccount: 'helm-runner',
      serviceName: 'api',
      buildUUID: 'build-123',
      isStatic: false,
      containers: [{ name: 'helm', image: 'alpine/helm:3.15.4' }],
    });

    expect(job.spec?.template.metadata?.annotations).toEqual({
      'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
    });
  });
});
