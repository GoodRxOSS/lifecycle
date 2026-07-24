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

import { LogStage, LogStageType } from '../stages';

describe('LogStage', () => {
  it('should export all required webhook stages', () => {
    const webhookStages = ['WEBHOOK_RECEIVED', 'WEBHOOK_QUEUED', 'WEBHOOK_PROCESSING', 'WEBHOOK_SKIPPED'];
    for (const stage of webhookStages) {
      expect(LogStage).toHaveProperty(stage);
      expect(typeof LogStage[stage as keyof typeof LogStage]).toBe('string');
    }
  });

  it('should export all required build stages', () => {
    const buildStages = [
      'BUILD_CREATED',
      'BUILD_QUEUED',
      'BUILD_STARTING',
      'BUILD_IMAGE_BUILDING',
      'BUILD_IMAGE_PUSHING',
      'BUILD_COMPLETE',
      'BUILD_FAILED',
    ];
    for (const stage of buildStages) {
      expect(LogStage).toHaveProperty(stage);
      expect(typeof LogStage[stage as keyof typeof LogStage]).toBe('string');
    }
  });

  it('should export all required deploy stages', () => {
    const deployStages = [
      'DEPLOY_QUEUED',
      'DEPLOY_STARTING',
      'DEPLOY_HELM_INSTALLING',
      'DEPLOY_HELM_COMPLETE',
      'DEPLOY_COMPLETE',
      'DEPLOY_FAILED',
    ];
    for (const stage of deployStages) {
      expect(LogStage).toHaveProperty(stage);
      expect(typeof LogStage[stage as keyof typeof LogStage]).toBe('string');
    }
  });

  it('should export all required cleanup stages', () => {
    const cleanupStages = ['CLEANUP_STARTING', 'CLEANUP_COMPLETE', 'CLEANUP_FAILED'];
    for (const stage of cleanupStages) {
      expect(LogStage).toHaveProperty(stage);
      expect(typeof LogStage[stage as keyof typeof LogStage]).toBe('string');
    }
  });

  it('should export all required label stages', () => {
    const labelStages = ['LABEL_PROCESSING', 'LABEL_COMPLETE', 'LABEL_FAILED'];
    for (const stage of labelStages) {
      expect(LogStage).toHaveProperty(stage);
      expect(typeof LogStage[stage as keyof typeof LogStage]).toBe('string');
    }
  });

  it('should export all required comment stages', () => {
    const commentStages = ['COMMENT_PROCESSING', 'COMMENT_COMPLETE', 'COMMENT_FAILED'];
    for (const stage of commentStages) {
      expect(LogStage).toHaveProperty(stage);
      expect(typeof LogStage[stage as keyof typeof LogStage]).toBe('string');
    }
  });

  it('should export all required config stages', () => {
    const configStages = ['CONFIG_REFRESH', 'CONFIG_FAILED'];
    for (const stage of configStages) {
      expect(LogStage).toHaveProperty(stage);
      expect(typeof LogStage[stage as keyof typeof LogStage]).toBe('string');
    }
  });

  it('should export all required ingress stages', () => {
    const ingressStages = ['INGRESS_PROCESSING', 'INGRESS_COMPLETE', 'INGRESS_FAILED'];
    for (const stage of ingressStages) {
      expect(LogStage).toHaveProperty(stage);
      expect(typeof LogStage[stage as keyof typeof LogStage]).toBe('string');
    }
  });

  it('should have stage values following dot-notation convention', () => {
    const allValues = Object.values(LogStage);

    for (const value of allValues) {
      expect(value).toMatch(/^[a-z]+\.[a-z.]+$/);
    }
  });

  it('should allow LogStageType to accept any LogStage value', () => {
    const assignStage = (stage: LogStageType): string => stage;

    expect(assignStage(LogStage.WEBHOOK_RECEIVED)).toBe('webhook.received');
    expect(assignStage(LogStage.BUILD_COMPLETE)).toBe('build.complete');
    expect(assignStage(LogStage.DEPLOY_FAILED)).toBe('deploy.failed');
    expect(assignStage(LogStage.LABEL_PROCESSING)).toBe('label.processing');
    expect(assignStage(LogStage.COMMENT_COMPLETE)).toBe('comment.complete');
    expect(assignStage(LogStage.CONFIG_REFRESH)).toBe('config.refresh');
    expect(assignStage(LogStage.INGRESS_COMPLETE)).toBe('ingress.complete');
  });
});
