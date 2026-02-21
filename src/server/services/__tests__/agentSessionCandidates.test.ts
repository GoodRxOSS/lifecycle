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

import { YamlConfigParser } from 'server/lib/yamlConfigParser';
import type { Deploy } from 'server/models';
import { resolveAgentSessionServiceCandidates } from '../agentSessionCandidates';
import { DeployStatus, DeployTypes } from 'shared/constants';

describe('agentSessionCandidates', () => {
  test('includes only repo-local dev services backed by lifecycle-managed image builds', () => {
    const parser = new YamlConfigParser();
    const lifecycleConfig = parser.parseYamlConfigFromString(`---
version: '1.0.0'
services:
  - name: 'github-app'
    dev:
      image: 'repo/github-app:dev'
      command: 'npm run dev'
    github:
      repository: 'org/example'
      branchName: 'main'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'app/Dockerfile'
  - name: 'helm-app'
    dev:
      image: 'repo/helm-app:dev'
      command: 'npm run dev'
    helm:
      repository: 'org/example'
      branchName: 'main'
      chart:
        name: './helm/app'
      docker:
        defaultTag: 'main'
        app:
          dockerfilePath: 'helm-app/Dockerfile'
  - name: 'redis'
    dev:
      image: 'repo/redis:dev'
      command: 'redis-server'
    helm:
      repository: 'org/example'
      branchName: 'main'
      chart:
        name: 'redis'
  - name: 'external-image'
    dev:
      image: 'repo/external-image:dev'
      command: 'sleep infinity'
    docker:
      dockerImage: 'docker.io/org/external-image'
      defaultTag: 'latest'
`);

    const deploys = [
      {
        id: 11,
        active: true,
        status: DeployStatus.DEPLOYED,
        deployable: { name: 'github-app', type: DeployTypes.GITHUB },
      },
      {
        id: 12,
        active: true,
        status: DeployStatus.READY,
        deployable: { name: 'helm-app', type: DeployTypes.HELM },
      },
      {
        id: 13,
        active: true,
        status: DeployStatus.DEPLOYED,
        deployable: { name: 'redis', type: DeployTypes.HELM },
      },
      {
        id: 14,
        active: true,
        status: DeployStatus.DEPLOYED,
        deployable: { name: 'external-image', type: DeployTypes.DOCKER },
      },
      {
        id: 15,
        active: true,
        status: DeployStatus.DEPLOYED,
        deployable: { name: 'other-repo-service', type: DeployTypes.GITHUB },
      },
    ] as unknown as Deploy[];

    expect(resolveAgentSessionServiceCandidates(deploys, lifecycleConfig)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'github-app',
          type: DeployTypes.GITHUB,
          detail: DeployStatus.DEPLOYED,
          deployId: 11,
        }),
        expect.objectContaining({
          name: 'helm-app',
          type: DeployTypes.HELM,
          detail: DeployStatus.READY,
          deployId: 12,
        }),
      ])
    );

    const names = resolveAgentSessionServiceCandidates(deploys, lifecycleConfig).map((candidate) => candidate.name);
    expect(names).toEqual(['github-app', 'helm-app']);
  });
});
