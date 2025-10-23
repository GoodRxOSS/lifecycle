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

import { BuildStatus, DeployStatus, DeployTypes, PullRequestStatus } from 'shared/constants';

export interface ConversationState {
  buildUuid: string;
  messages: DebugMessage[];
  lastActivity: number;
  contextSnapshot?: Partial<DebugContext>;
}

export interface DebugMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface DebugContext {
  buildUuid: string;
  namespace: string;
  lifecycleContext: LifecycleContext;
  lifecycleYaml?: {
    path: string;
    content: string;
    error?: string;
  };
  services: ServiceDebugInfo[];
  gatheredAt: Date;
  warnings?: ContextWarning[];
  errors?: ContextError[];
}

export interface ContextWarning {
  source: 'kubernetes' | 'lifecycle' | 'logs';
  message: string;
  details?: string;
}

export interface ContextError {
  source: 'kubernetes' | 'lifecycle' | 'logs';
  message: string;
  error: string;
  recoverable: boolean;
}

export interface LifecycleContext {
  build: BuildInfo;
  pullRequest: PullRequestInfo;
  environment: EnvironmentInfo;
  deploys: DeployInfo[];
  repository: RepositoryInfo;
}

export interface BuildInfo {
  uuid: string;
  status: BuildStatus;
  statusMessage: string;
  namespace: string;
  sha: string;
  trackDefaultBranches: boolean;
  capacityType: string;
  enabledFeatures: string[];
  dependencyGraph: Record<string, any>;
  dashboardLinks: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  username: string;
  branch: string;
  baseBranch: string;
  status: PullRequestStatus;
  url: string;
  latestCommit: string;
  fullName: string;
  commentId?: number;
}

export interface EnvironmentInfo {
  id: number;
  name: string;
  config: Record<string, any>;
}

export interface DeployInfo {
  uuid: string;
  serviceName: string;
  status: DeployStatus;
  statusMessage: string;
  type: DeployTypes;
  dockerImage: string;
  branch: string;
  repoName: string;
  buildNumber: number;
  buildPipelineId?: string;
  deployPipelineId?: string;
  builderEngine?: string;
  helmChart?: string;
  repositoryId?: number;
  env: Record<string, string>;
  initEnv: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeployableInfo {
  serviceName: string;
  type: DeployTypes;
  repositoryId: number;
  defaultBranchName: string;
  commentBranchName: string;
  helm: any;
  deploymentDependsOn: string[];
  builder: any;
}

export interface RepositoryInfo {
  name: string;
  githubRepositoryId: number;
  url: string;
}

export interface ServiceDebugInfo {
  name: string;
  type: string;
  status: 'pending' | 'building' | 'deploying' | 'running' | 'failed';
  deployInfo: DeployInfo;
  deployment?: K8sDeployment;
  pods: PodDebugInfo[];
  events: K8sEvent[];
  issues: DiagnosedIssue[];
}

export interface K8sDeployment {
  name: string;
  replicas: {
    desired: number;
    current: number;
    ready: number;
    available: number;
  };
  conditions: any[];
  strategy: string;
  containers: Array<{
    name: string;
    image: string;
  }>;
}

export interface PodDebugInfo {
  name: string;
  phase: string;
  conditions: any[];
  containerStatuses: any[];
  recentLogs: string;
  events: K8sEvent[];
}

export interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  firstTimestamp: Date;
  lastTimestamp: Date;
}

export interface DiagnosedIssue {
  severity: 'critical' | 'warning' | 'info';
  category: 'image' | 'resources' | 'configuration' | 'network' | 'other';
  title: string;
  description: string;
  suggestedFix: string;
  detectedBy: 'rules' | 'llm';
  suggestedActions?: SuggestedAction[];
}

export interface SuggestedAction {
  id: string;
  label: string;
  description: string;
  action: 'kubectl_patch' | 'kubectl_delete' | 'kubectl_restart' | 'kubectl_scale' | 'view_logs' | 'view_events';
  params: {
    resourceType?: string;
    resourceName?: string;
    namespace?: string;
    patch?: any;
    replicas?: number;
    containerName?: string;
  };
  confirmation?: string;
  dangerous?: boolean;
}

export interface InvestigationStep {
  stepNumber: number;
  tool: string;
  args: Record<string, any>;
  completed: boolean;
  dependsOn?: number;
  result?: any;
}

export interface ServiceInvestigationPlan {
  serviceName: string;
  status: DeployStatus.BUILD_FAILED | DeployStatus.DEPLOY_FAILED;
  type: 'codefresh' | 'native';
  steps: InvestigationStep[];
  completed: boolean;
}

export interface InvestigationPlan {
  services: ServiceInvestigationPlan[];
  allCompleted: boolean;
}

export interface FileChange {
  path: string; // The exact file path
  lineNumber?: number;
  lineNumberEnd?: number;
  description?: string; // What's being changed in this specific file
  oldContent?: string; // For multi-line changes - the current content
  newContent?: string; // For multi-line changes - what it should be
}

export interface ServiceInvestigationResult {
  serviceName: string;
  status: DeployStatus.BUILD_FAILED | DeployStatus.DEPLOY_FAILED;
  issue: string;
  keyError?: string;
  errorSource?: string;
  errorSourceDetail?: string;
  suggestedFix: string;
  canAutoFix?: boolean;
  filePath?: string; // The primary file path (kept for backward compatibility)
  lineNumber?: number;
  lineNumberEnd?: number;
  files?: FileChange[]; // For multi-file fixes - if present, use this instead of single file fields
  commitUrl?: string;
}

export interface StructuredDebugResponse {
  type: 'investigation_complete';
  summary: string;
  fixesApplied: boolean;
  services: ServiceInvestigationResult[];
  repository?: {
    owner: string;
    name: string;
    branch: string;
  };
}

export interface ModelConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  default: boolean;
  maxTokens: number;
}

export interface ProviderConfig {
  name: string;
  enabled: boolean;
  apiKeyEnvVar: string;
  models: ModelConfig[];
}

export interface AIAgentConfig {
  enabled: boolean;
  providers: ProviderConfig[];
  maxMessagesPerSession: number;
  sessionTTL: number;
}
