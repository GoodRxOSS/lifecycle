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

import { assertLogStreamPodContainer } from 'server/lib/logStreamPodAccess';

const pod = {
  spec: {
    initContainers: [{ name: 'clone' }],
    containers: [{ name: 'web' }, { name: 'sidecar' }],
  },
};

function reader(result: Promise<{ body: unknown }>) {
  return { readNamespacedPod: jest.fn().mockReturnValue(result) };
}

describe('assertLogStreamPodContainer', () => {
  it('accepts a pod in the pinned namespace by its main or init container name', async () => {
    const coreV1 = reader(Promise.resolve({ body: pod }));

    await expect(
      assertLogStreamPodContainer({ namespace: 'env-build-1', podName: 'web-0', containerName: 'web' }, coreV1)
    ).resolves.toBeUndefined();
    await expect(
      assertLogStreamPodContainer({ namespace: 'env-build-1', podName: 'web-0', containerName: '[init] clone' }, coreV1)
    ).resolves.toBeUndefined();
    expect(coreV1.readNamespacedPod).toHaveBeenCalledWith('web-0', 'env-build-1');
  });

  it('refuses a pod the pinned namespace does not contain', async () => {
    const coreV1 = reader(Promise.reject({ response: { statusCode: 404 } }));

    await expect(
      assertLogStreamPodContainer({ namespace: 'env-build-1', podName: 'kube-apiserver', containerName: 'web' }, coreV1)
    ).rejects.toMatchObject({ httpStatus: 404, code: 'log_stream_pod_not_found' });
  });

  it('refuses a container that does not exist on the pod', async () => {
    const coreV1 = reader(Promise.resolve({ body: pod }));

    await expect(
      assertLogStreamPodContainer({ namespace: 'env-build-1', podName: 'web-0', containerName: 'root' }, coreV1)
    ).rejects.toMatchObject({ httpStatus: 404, code: 'log_stream_container_not_found' });
  });

  it('rethrows Kubernetes failures other than a missing pod', async () => {
    const failure = Object.assign(new Error('forbidden'), { response: { statusCode: 403 } });
    const coreV1 = reader(Promise.reject(failure));

    await expect(
      assertLogStreamPodContainer({ namespace: 'env-build-1', podName: 'web-0', containerName: 'web' }, coreV1)
    ).rejects.toBe(failure);
  });
});
