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

import { Deploy } from 'server/models';

export type ContainerBuildOptions = {
  afterBuildPipelineId: string;
  ecrRepo: string;
  branch: string;
  buildPipelineName: string;
  cacheFrom: string;
  deploy: Partial<Deploy>;
  detatchAfterBuildPipeline: boolean;
  dockerfilePath: string;
  ecrDomain: string;
  envVars: Record<string, string>;
  gitOrg?: string;
  initDockerfilePath: string;
  repo: string;
  revision: string;
  runtimeName: string;
  tag: string;
  uuid?: string;
  initTag?: string;
  author?: string;
  enabledFeatures?: string[];
  deployCluster?: string;
};
