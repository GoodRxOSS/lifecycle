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

import { AIAgentPromptBuilder, PromptContext } from '../builder';
import { DebugContext } from '../../../types/aiAgent';

jest.mock('../sectionRegistry', () => ({
  assembleBasePrompt: () => 'base-prompt',
  PROMPT_SECTIONS: [{ id: 'safety', content: '# Safety' }],
}));

jest.mock('../../context/contextSummarizer', () => ({
  summarizeLifecycleYaml: () => ({ parsed: true, text: 'yaml summary' }),
}));

function makeDeploy(overrides: Record<string, any> = {}) {
  return {
    uuid: 'deploy-1',
    serviceName: 'svc-a',
    status: 'RUNNING',
    statusMessage: '',
    type: 'service',
    dockerImage: 'img:latest',
    branch: 'main',
    repoName: 'org/repo-a',
    buildNumber: 1,
    env: {},
    initEnv: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeServiceDebug(name: string, status = 'running' as any) {
  return {
    name,
    type: 'service',
    status,
    deployInfo: makeDeploy({ serviceName: name }),
    pods: [],
    events: [],
    issues: [],
  };
}

function makeContext(deploys: any[], services: any[] = [], repoFullName = 'org/repo-a'): PromptContext {
  const debugContext: DebugContext = {
    buildUuid: 'build-123',
    namespace: 'ns-test',
    gatheredAt: new Date('2026-01-15T10:00:00Z'),
    lifecycleContext: {
      build: {
        uuid: 'build-123',
        status: 'RUNNING' as any,
        statusMessage: '',
        namespace: 'ns-test',
        sha: 'abc123',
        trackDefaultBranches: false,
        capacityType: 'spot',
        enabledFeatures: [],
        dependencyGraph: {},
        dashboardLinks: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      pullRequest: {
        number: 42,
        title: 'Test PR',
        username: 'dev',
        branch: 'feature',
        baseBranch: 'main',
        status: 'open' as any,
        url: 'https://github.com/org/repo-a/pull/42',
        latestCommit: 'abc123',
        fullName: repoFullName,
      },
      environment: { id: 1, name: 'test', config: {} },
      deploys,
      repository: { name: repoFullName, githubRepositoryId: 1, url: '' },
    },
    services,
    lifecycleYaml: { path: 'lifecycle.yaml', content: 'version: 2' },
  };

  return {
    provider: 'anthropic',
    debugContext,
    conversationHistory: [],
    userMessage: 'help',
  };
}

describe('AIAgentPromptBuilder', () => {
  let builder: AIAgentPromptBuilder;

  beforeEach(() => {
    builder = new AIAgentPromptBuilder();
  });

  describe('buildEnvironmentContext via build()', () => {
    it('includes gathered-at timestamp', () => {
      const ctx = makeContext([makeDeploy()], [makeServiceDebug('svc-a')]);
      const result = builder.build(ctx);
      const userMsg = result.messages[result.messages.length - 1].content;
      expect(userMsg).toContain('Environment State (gathered: 2026-01-15T10:00:00.000Z)');
    });

    it('uses structured header format', () => {
      const ctx = makeContext([makeDeploy()], [makeServiceDebug('svc-a')]);
      const result = builder.build(ctx);
      const userMsg = result.messages[result.messages.length - 1].content;
      expect(userMsg).toContain('Build: build-123 | Status: RUNNING | Namespace: ns-test');
      expect(userMsg).toContain('PR: #42 "Test PR" by dev');
      expect(userMsg).toContain('Repo: org/repo-a @ feature (base: main)');
    });

    it('does not include duplicate K8s section', () => {
      const failingSvc = makeServiceDebug('svc-a', 'failed');
      failingSvc.issues = [
        {
          severity: 'critical',
          category: 'image',
          title: 'CrashLoop',
          description: '',
          suggestedFix: '',
          detectedBy: 'rules',
        },
      ];
      const ctx = makeContext([makeDeploy({ serviceName: 'svc-a', status: 'DEPLOY_FAILED' })], [failingSvc]);
      const result = builder.build(ctx);
      const userMsg = result.messages[result.messages.length - 1].content;
      expect(userMsg).not.toContain('INITIAL K8S STATE');
    });

    it('uses markdown header for lifecycle yaml section', () => {
      const ctx = makeContext([makeDeploy()], [makeServiceDebug('svc-a')]);
      const result = builder.build(ctx);
      const userMsg = result.messages[result.messages.length - 1].content;
      expect(userMsg).toContain('## Configuration (lifecycle.yaml)');
      expect(userMsg).not.toContain('===== LIFECYCLE.YAML SUMMARY =====');
    });

    describe('single-repo services', () => {
      it('renders flat without repo sub-headers', () => {
        const deploys = [
          makeDeploy({ serviceName: 'svc-a', repoName: 'org/repo-a' }),
          makeDeploy({ serviceName: 'svc-b', repoName: 'org/repo-a', status: 'BUILD_FAILED' }),
        ];
        const services = [makeServiceDebug('svc-a'), makeServiceDebug('svc-b', 'failed')];
        const ctx = makeContext(deploys, services);
        const result = builder.build(ctx);
        const userMsg = result.messages[result.messages.length - 1].content;
        expect(userMsg).toContain('## Services (2 total, 1 failing)');
        expect(userMsg).not.toContain('### org/repo-a');
        expect(userMsg).toContain('FAILING:');
        expect(userMsg).toContain('HEALTHY (1): svc-a');
      });
    });

    describe('multi-repo services', () => {
      it('groups services by repository with sub-headers', () => {
        const deploys = [
          makeDeploy({ serviceName: 'svc-a', repoName: 'org/repo-a', status: 'BUILD_FAILED' }),
          makeDeploy({ serviceName: 'svc-b', repoName: 'org/repo-a' }),
          makeDeploy({ serviceName: 'svc-c', repoName: 'org/repo-b' }),
        ];
        const services = [makeServiceDebug('svc-a', 'failed'), makeServiceDebug('svc-b'), makeServiceDebug('svc-c')];
        const ctx = makeContext(deploys, services);
        const result = builder.build(ctx);
        const userMsg = result.messages[result.messages.length - 1].content;
        expect(userMsg).toContain('## Services (3 total, 1 failing)');
        expect(userMsg).toContain('### org/repo-a');
        expect(userMsg).toContain('### org/repo-b');

        const repoAIdx = userMsg.indexOf('### org/repo-a');
        const repoBIdx = userMsg.indexOf('### org/repo-b');
        const failingIdx = userMsg.indexOf('FAILING:', repoAIdx);
        expect(failingIdx).toBeGreaterThan(repoAIdx);
        expect(failingIdx).toBeLessThan(repoBIdx);
      });

      it('uses primary repo fullName when repoName is missing', () => {
        const deploys = [
          makeDeploy({ serviceName: 'svc-a', repoName: '' }),
          makeDeploy({ serviceName: 'svc-b', repoName: 'org/repo-b' }),
        ];
        const services = [makeServiceDebug('svc-a'), makeServiceDebug('svc-b')];
        const ctx = makeContext(deploys, services, 'org/repo-a');
        const result = builder.build(ctx);
        const userMsg = result.messages[result.messages.length - 1].content;
        expect(userMsg).toContain('### org/repo-a');
        expect(userMsg).toContain('### org/repo-b');
      });
    });
  });
});
