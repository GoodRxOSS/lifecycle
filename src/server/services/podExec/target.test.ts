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

import { resolveTarget } from './target';
import type { Principal } from 'server/lib/principal';
const getBuild = jest.fn();
const readPod = jest.fn();
const authorize = jest.fn();
jest.mock('server/services/build', () => ({
  __esModule: true,
  default: class {
    getBuildByUUID(...args: unknown[]) {
      return getBuild(...args);
    }
  },
}));
jest.mock('server/lib/repositoryAuthorization', () => ({
  assertBuildRepositoryAllowed: (...args: unknown[]) => authorize(...args),
}));
jest.mock('server/lib/kubernetes/getDeploymentPods', () => ({
  loadKubeConfig: () => ({ makeApiClient: () => ({ readNamespacedPod: readPod }) }),
}));
const principal = { kind: 'user' } as Principal;
const pod = () => ({
  metadata: { uid: 'uid', labels: {} },
  spec: { containers: [{ name: 'app' }], initContainers: [{ name: 'init' }] },
  status: {
    containerStatuses: [{ name: 'app', containerID: 'app-id', restartCount: 2, state: { running: {} } }],
    initContainerStatuses: [{ name: 'init', containerID: 'init-id', restartCount: 0, state: { running: {} } }],
  },
});
describe('pod exec target authorization', () => {
  beforeEach(() => {
    getBuild.mockResolvedValue({ id: 1, uuid: 'demo', namespace: 'env-demo', kind: 'environment' });
    readPod.mockResolvedValue({ body: pod() });
    authorize.mockResolvedValue(undefined);
  });
  test.each(['app', 'init'])(
    'resolves a running %s container only in the stored Environment namespace',
    async (container) => {
      const target = await resolveTarget(principal, 'demo', 'pod', container);
      expect(target.container).toBe(container);
      expect(target.podUid).toBe('uid');
      expect(readPod).toHaveBeenCalledWith('pod', 'env-demo');
      expect(authorize).toHaveBeenCalled();
    }
  );
  test('rejects a removed Environment without touching Kubernetes', async () => {
    getBuild.mockResolvedValue(null);
    await expect(resolveTarget(principal, 'demo', 'pod', 'app')).rejects.toMatchObject({
      code: 'environment_unavailable',
    });
    expect(readPod).not.toHaveBeenCalled();
  });
  test.each([
    ['sandbox', 'env-demo', 'environment_kind_not_supported'],
    ['environment', 'kube-system', 'namespace_not_supported'],
  ])('rejects %s in %s', async (kind, namespace, code) => {
    getBuild.mockResolvedValue({ id: 1, uuid: 'demo', namespace, kind });
    await expect(resolveTarget(principal, 'demo', 'pod', 'app')).rejects.toMatchObject({ code });
    expect(readPod).not.toHaveBeenCalled();
  });
  test('enforces repository access before reading a pod', async () => {
    authorize.mockRejectedValue(new Error('denied'));
    await expect(resolveTarget(principal, 'demo', 'pod', 'app')).rejects.toThrow('denied');
    expect(readPod).not.toHaveBeenCalled();
  });
  test.each(['native-build', 'native-helm'])('excludes %s tooling', async (app) => {
    const p = pod();
    p.metadata.labels = { 'app.kubernetes.io/name': app };
    readPod.mockResolvedValue({ body: p });
    await expect(resolveTarget(principal, 'demo', 'pod', 'app')).rejects.toMatchObject({
      code: 'build_tooling_excluded',
    });
  });
  test('rejects unknown, waiting and terminated containers', async () => {
    await expect(resolveTarget(principal, 'demo', 'pod', 'other')).rejects.toMatchObject({
      code: 'container_not_running',
    });
    const p = pod();
    p.status.containerStatuses[0].state = {} as any;
    readPod.mockResolvedValue({ body: p });
    await expect(resolveTarget(principal, 'demo', 'pod', 'app')).rejects.toMatchObject({
      code: 'container_not_running',
    });
  });
  test('revalidates build identity, pod UID and container instance', async () => {
    const target = await resolveTarget(principal, 'demo', 'pod', 'app');
    const p = pod();
    p.status.containerStatuses[0].containerID = 'replacement';
    readPod.mockResolvedValue({ body: p });
    await expect(resolveTarget(principal, 'demo', 'pod', 'app', target)).rejects.toMatchObject({
      code: 'target_changed',
    });
    expect(getBuild).toHaveBeenLastCalledWith('demo', { liveOnly: true, expectedBuildId: 1 });
  });
  test.each([
    [404, 'pod_unavailable'],
    [403, 'kubernetes_forbidden'],
    [503, 'kubernetes_error'],
  ])('classifies Kubernetes %s safely', async (statusCode, code) => {
    readPod.mockRejectedValue({ statusCode, body: { message: 'sensitive upstream detail' } });
    await expect(resolveTarget(principal, 'demo', 'pod', 'app')).rejects.toMatchObject({ code });
  });
});
