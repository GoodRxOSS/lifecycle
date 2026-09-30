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

import { ExecError, kubernetesReadError } from './errors';
import * as k8s from '@kubernetes/client-node';
import BuildService from 'server/services/build';
import { assertBuildRepositoryAllowed } from 'server/lib/repositoryAuthorization';
import type { Principal } from 'server/lib/principal';
import { loadKubeConfig } from 'server/lib/kubernetes/getDeploymentPods';
import type { Target } from './protocol';

/** Called after explicit pod-exec policy; browser never supplies namespace. */
export async function resolveTarget(
  principal: Principal,
  uuid: string,
  podName: string,
  container: string,
  expected?: Target
): Promise<Target> {
  const build = await new BuildService().getBuildByUUID(uuid, {
    liveOnly: true,
    expectedBuildId: expected?.buildId,
  });
  if (!build?.namespace) throw new ExecError('environment_unavailable');
  await assertBuildRepositoryAllowed(principal, build);
  // MVP excludes sandbox/agent sessions; they have separate ownership semantics.
  if (build.kind !== 'environment') throw new ExecError('environment_kind_not_supported');
  if (build.namespace !== `env-${build.uuid}`) throw new ExecError('namespace_not_supported');
  const api = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
  const { body: pod } = await api.readNamespacedPod(podName, build.namespace).catch((error) => {
    throw kubernetesReadError(error);
  });
  if (!pod.metadata?.uid || pod.metadata.deletionTimestamp) throw new ExecError('pod_unavailable');
  const app = pod.metadata.labels?.['app.kubernetes.io/name'];
  if (app === 'native-build' || app === 'native-helm') throw new ExecError('build_tooling_excluded');
  // Namespace is the Environment authority. A service label is display data, not authorization.
  const spec = [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])];
  const status = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])];
  const current = status.find((c) => c.name === container);
  if (!spec.some((c) => c.name === container) || !current?.state?.running || !current.containerID) {
    throw new ExecError('container_not_running');
  }
  const target: Target = {
    buildId: build.id,
    uuid: build.uuid,
    namespace: build.namespace,
    podName,
    podUid: pod.metadata.uid,
    container,
    containerId: current.containerID,
    restartCount: current.restartCount,
  };
  if (expected && JSON.stringify(target) !== JSON.stringify(expected)) throw new ExecError('target_changed');
  return target;
}
