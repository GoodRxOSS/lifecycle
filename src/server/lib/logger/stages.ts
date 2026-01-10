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

export const LogStage = {
  WEBHOOK_RECEIVED: 'webhook.received',
  WEBHOOK_QUEUED: 'webhook.queued',
  WEBHOOK_PROCESSING: 'webhook.processing',
  WEBHOOK_COMPLETE: 'webhook.complete',
  WEBHOOK_SKIPPED: 'webhook.skipped',

  BUILD_CREATED: 'build.created',
  BUILD_QUEUED: 'build.queued',
  BUILD_STARTING: 'build.starting',
  BUILD_IMAGE_BUILDING: 'build.image.building',
  BUILD_IMAGE_PUSHING: 'build.image.pushing',
  BUILD_COMPLETE: 'build.complete',
  BUILD_FAILED: 'build.failed',

  DEPLOY_QUEUED: 'deploy.queued',
  DEPLOY_STARTING: 'deploy.starting',
  DEPLOY_HELM_INSTALLING: 'deploy.helm.installing',
  DEPLOY_HELM_COMPLETE: 'deploy.helm.complete',
  DEPLOY_COMPLETE: 'deploy.complete',
  DEPLOY_FAILED: 'deploy.failed',

  CLEANUP_STARTING: 'cleanup.starting',
  CLEANUP_COMPLETE: 'cleanup.complete',
  CLEANUP_FAILED: 'cleanup.failed',

  LABEL_PROCESSING: 'label.processing',
  LABEL_COMPLETE: 'label.complete',
  LABEL_FAILED: 'label.failed',

  COMMENT_PROCESSING: 'comment.processing',
  COMMENT_COMPLETE: 'comment.complete',
  COMMENT_FAILED: 'comment.failed',

  CONFIG_REFRESH: 'config.refresh',
  CONFIG_FAILED: 'config.failed',

  INGRESS_PROCESSING: 'ingress.processing',
  INGRESS_COMPLETE: 'ingress.complete',
  INGRESS_FAILED: 'ingress.failed',
} as const;

export type LogStageType = (typeof LogStage)[keyof typeof LogStage];
