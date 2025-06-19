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

import { Helm, KedaScaleToZero } from 'server/models/yaml';

export type GlobalConfig = {
  lifecycleDefaults: LifecycleDefaults;
  helmDefaults: HelmDefaults;
  buildDefaults?: BuildDefaults;
  postgresql: Helm;
  mysql: Helm;
  redis: Helm;
  elasticsearch: Helm;
  publicChart: PublicChart;
  lifecycleIgnores: LifecycleIgnores;
  deletePendingHelmReleaseStep: DeletePendingHelmReleaseStep;
  kedaScaleToZero: KedaScaleToZero;
  serviceDefaults: Record<string, any>;
  domainDefaults: DomainDefaults;
  orgChart: OrgChart;
  auroraRestoreSettings: DatabaseSettings;
  rdsRestoreSettings: DatabaseSettings;
  serviceAccount: RoleSettings;
  features: Record<string, boolean>;
  app_setup: AppSetup;
};

export type AppSetup = {
  created: boolean;
  installed: boolean;
  restarted: boolean;
  url: string;
  state: string;
};

export type RoleSettings = {
  role: string;
  name?: string;
};

export type DatabaseSettings = {
  vpcId: string;
  accountId: string;
  region: string;
  securityGroupIds: string[];
  subnetGroupName: string;
  engine: string;
  engineVersion: string;
  tagMatch: {
    key: string;
  };
  instanceSize: string;
  restoreSize: string;
};

export type DomainDefaults = {
  http: string;
  grpc: string;
};

export type LifecycleIgnores = {
  github?: {
    branches?: string[];
    events?: string[];
    organizations?: string[];
  };
};

export type LifecycleDefaults = {
  defaultUUID: string;
  defaultPublicUrl: string;
  cfStepType: string;
  ecrDomain: string;
  ecrRegistry: string;
  buildPipeline: string;
  deployNamespace: string;
  deployCluster: string;
  helmDeployPipeline: string;
  ingressClassName?: string;
};

export type PublicChart = {
  block: boolean;
};

export type OrgChart = {
  name: string;
};

export type DeletePendingHelmReleaseStep = {
  delete: boolean;
  static_delete?: boolean;
};

export type HelmDefaults = {
  nativeHelm?: NativeHelmConfig;
};

export type NativeHelmConfig = {
  enabled: boolean;
  defaultHelmVersion?: string;
  jobTimeout?: number;
  serviceAccount?: string;
  defaultArgs?: string;
};

export type BuildDefaults = {
  jobTimeout?: number;
  serviceAccount?: string;
  resources?: {
    buildkit?: ResourceRequirements;
    kaniko?: ResourceRequirements;
  };
  buildkit?: {
    endpoint?: string;
    healthCheckTimeout?: number;
    insecure?: boolean;
  };
};

export type ResourceRequirements = {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
};
