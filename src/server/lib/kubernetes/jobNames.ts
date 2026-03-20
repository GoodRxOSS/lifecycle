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

export const KUBERNETES_NAME_MAX_LENGTH = 63;

interface BuildDeployJobNameOptions {
  deployUuid: string;
  jobId: string;
  shortSha: string;
  maxLength?: number;
}

function buildJobName({
  deployUuid,
  suffix,
  maxLength = KUBERNETES_NAME_MAX_LENGTH,
}: {
  deployUuid: string;
  suffix: string;
  maxLength?: number;
}): string {
  const fullName = `${deployUuid}-${suffix}`;

  if (fullName.length <= maxLength) {
    return fullName.replace(/-+$/g, '');
  }

  const maxPrefixLength = maxLength - suffix.length - 1;

  if (maxPrefixLength <= 0) {
    return suffix.substring(0, maxLength).replace(/-+$/g, '');
  }

  const truncatedPrefix = deployUuid.substring(0, maxPrefixLength).replace(/-+$/g, '');
  return truncatedPrefix ? `${truncatedPrefix}-${suffix}` : suffix;
}

export function buildDeployJobName({
  deployUuid,
  jobId,
  shortSha,
  maxLength = KUBERNETES_NAME_MAX_LENGTH,
}: BuildDeployJobNameOptions): string {
  return buildJobName({
    deployUuid,
    suffix: `deploy-${jobId}-${shortSha}`,
    maxLength,
  });
}

export function buildNativeBuildJobName({
  deployUuid,
  jobId,
  shortSha,
  maxLength = KUBERNETES_NAME_MAX_LENGTH,
}: BuildDeployJobNameOptions): string {
  return buildJobName({
    deployUuid,
    suffix: `build-${jobId}-${shortSha}`,
    maxLength,
  });
}
