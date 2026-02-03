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

import { summarizeLifecycleYaml } from '../contextSummarizer';
import { countTokens } from '../../prompts/tokenCounter';

describe('summarizeLifecycleYaml', () => {
  describe('parsing and structure', () => {
    it('parses valid YAML with environment and services', () => {
      const yaml = `
version: "1.0.0"
environment:
  autoDeploy: true
  defaultServices:
    - name: api
    - name: web
  optionalServices:
    - name: redis
services:
  - name: api-service
    helm:
      repository: org/api
      branchName: main
      chart:
        name: org-chart
  - name: db
    docker:
      dockerImage: postgres
      defaultTag: "14"
  - name: ext
    externalHttp:
      defaultInternalHostname: ext.internal
      defaultPublicUrl: https://ext.example.com
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.parsed).toBe(true);
      expect(result.serviceCount).toBe(3);
      expect(result.text).toContain('ENVIRONMENT:');
      expect(result.text).toContain('SERVICES (3):');
      expect(result.text).toContain('api-service');
      expect(result.text).toContain('(helm)');
      expect(result.text).toContain('db');
      expect(result.text).toContain('(docker)');
      expect(result.text).toContain('ext');
      expect(result.text).toContain('(externalHttp)');
    });

    it('includes version in environment section', () => {
      const yaml = `
version: "1.0.0"
services: []
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('Version: 1.0.0');
    });

    it('includes autoDeploy in environment section', () => {
      const yaml = `
environment:
  autoDeploy: true
services: []
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('AutoDeploy: true');
    });

    it('lists default and optional services', () => {
      const yaml = `
environment:
  defaultServices:
    - name: api
    - name: web
  optionalServices:
    - name: redis
services: []
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('Default Services: api, web');
      expect(result.text).toContain('Optional Services: redis');
    });
  });

  describe('service type detection', () => {
    it('detects helm type', () => {
      const yaml = `
services:
  - name: svc
    helm:
      chart:
        name: my-chart
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('(helm)');
    });

    it('detects codefresh type', () => {
      const yaml = `
services:
  - name: svc
    codefresh:
      repository: org/repo
      branchName: main
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('(codefresh)');
    });

    it('detects github type', () => {
      const yaml = `
services:
  - name: svc
    github:
      repository: org/repo
      branchName: main
      docker:
        app:
          dockerfilePath: Dockerfile
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('(github)');
    });

    it('detects docker type', () => {
      const yaml = `
services:
  - name: svc
    docker:
      dockerImage: nginx
      defaultTag: latest
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('(docker)');
    });

    it('detects externalHttp type', () => {
      const yaml = `
services:
  - name: svc
    externalHttp:
      defaultInternalHostname: host.internal
      defaultPublicUrl: https://host.example.com
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('(externalHttp)');
    });

    it('prefers helm over codefresh when both present', () => {
      const yaml = `
services:
  - name: svc
    helm:
      chart:
        name: my-chart
    codefresh:
      repository: org/repo
      branchName: main
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('(helm)');
      expect(result.text).not.toContain('(codefresh)');
    });
  });

  describe('helm service extraction', () => {
    it('extracts repo, chart, valueFiles, docker config', () => {
      const yaml = `
services:
  - name: api
    helm:
      repository: org/api
      branchName: main
      chart:
        name: org-chart
        repoUrl: https://charts.example.com
        valueFiles:
          - helm/values.yaml
          - helm/overrides.yaml
      docker:
        builder:
          engine: buildkit
        app:
          dockerfilePath: Dockerfile
          ports:
            - 8080
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('Repo: org/api @ main');
      expect(result.text).toContain('Chart: org-chart (repoUrl: https://charts.example.com)');
      expect(result.text).toContain('ValueFiles: helm/values.yaml, helm/overrides.yaml');
      expect(result.text).toContain('Docker: buildkit | dockerfilePath: Dockerfile');
      expect(result.text).toContain('Ports: 8080');
    });

    it('handles helm service with minimal config', () => {
      const yaml = `
services:
  - name: minimal-helm
    helm:
      chart:
        name: my-chart
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.parsed).toBe(true);
      expect(result.text).toContain('minimal-helm');
      expect(result.text).toContain('(helm)');
    });
  });

  describe('docker service extraction', () => {
    it('extracts image and ports', () => {
      const yaml = `
services:
  - name: db
    docker:
      dockerImage: postgres
      defaultTag: "14"
      ports:
        - 5432
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('Image: postgres:14');
      expect(result.text).toContain('Ports: 5432');
    });
  });

  describe('config pointers', () => {
    it('aggregates referenced files from all services', () => {
      const yaml = `
services:
  - name: api
    helm:
      repository: org/api
      branchName: main
      chart:
        name: org-chart
        valueFiles:
          - helm/api-values.yaml
      docker:
        app:
          dockerfilePath: Dockerfile.api
  - name: web
    helm:
      repository: org/web
      branchName: main
      chart:
        name: org-chart
        valueFiles:
          - helm/web-values.yaml
      docker:
        app:
          dockerfilePath: Dockerfile.web
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('CONFIG POINTERS:');
      expect(result.text).toContain('Referenced Files:');
      expect(result.text).toContain('helm/api-values.yaml');
      expect(result.text).toContain('Dockerfile.api');
      expect(result.text).toContain('helm/web-values.yaml');
      expect(result.text).toContain('Dockerfile.web');
    });

    it('deduplicates referenced files', () => {
      const yaml = `
services:
  - name: api
    helm:
      chart:
        name: chart
      docker:
        app:
          dockerfilePath: Dockerfile
  - name: web
    helm:
      chart:
        name: chart
      docker:
        app:
          dockerfilePath: Dockerfile
`;
      const result = summarizeLifecycleYaml(yaml);
      const pointerSection = result.text.split('CONFIG POINTERS:')[1];
      const matches = pointerSection.match(/Dockerfile/g);
      expect(matches).toHaveLength(1);
    });

    it('omits CONFIG POINTERS when no files referenced', () => {
      const yaml = `
services:
  - name: db
    docker:
      dockerImage: postgres
      defaultTag: "14"
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).not.toContain('CONFIG POINTERS');
    });
  });

  describe('dependency extraction', () => {
    it('extracts deploymentDependsOn', () => {
      const yaml = `
services:
  - name: api
    deploymentDependsOn:
      - postgres
      - redis
    helm:
      chart:
        name: chart
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('DependsOn: postgres, redis');
    });

    it('extracts requires', () => {
      const yaml = `
services:
  - name: api
    requires:
      - name: cache
    helm:
      chart:
        name: chart
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.text).toContain('DependsOn: cache');
    });
  });

  describe('fallback behavior', () => {
    it('returns raw YAML on empty string', () => {
      const result = summarizeLifecycleYaml('');
      expect(result.parsed).toBe(false);
      expect(result.text).toBe('');
      expect(result.serviceCount).toBe(0);
    });

    it('returns raw YAML on malformed YAML', () => {
      const input = '{{invalid: yaml::';
      const result = summarizeLifecycleYaml(input);
      expect(result.parsed).toBe(false);
      expect(result.text).toBe(input);
      expect(result.serviceCount).toBe(0);
    });

    it('returns raw YAML when parsed result is not an object', () => {
      const result = summarizeLifecycleYaml('"just a string"');
      expect(result.parsed).toBe(false);
    });

    it('handles YAML with no services array', () => {
      const yaml = `
environment:
  autoDeploy: true
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.parsed).toBe(true);
      expect(result.serviceCount).toBe(0);
      expect(result.text).toContain('SERVICES (0)');
    });

    it('handles YAML with empty services array', () => {
      const yaml = `
services: []
`;
      const result = summarizeLifecycleYaml(yaml);
      expect(result.parsed).toBe(true);
      expect(result.serviceCount).toBe(0);
    });
  });

  describe('compression ratio', () => {
    const realisticYaml = `
version: "1.0.0"
environment:
  autoDeploy: true
  githubDeployments: true
  useGithubStatusComment: true
  enabledFeatures:
    - native-build
    - auto-deploy
  defaultServices:
    - name: api
      repository: org/api-service
      branch: main
    - name: web
      repository: org/web-app
      branch: main
    - name: worker
      repository: org/api-service
      branch: main
  optionalServices:
    - name: redis
    - name: postgres
    - name: monitoring
  webhooks:
    onSuccess:
      - url: https://hooks.slack.com/services/T00/B00/xxx
        method: POST
    onFailure:
      - url: https://hooks.slack.com/services/T00/B00/yyy
        method: POST
services:
  - name: api-service
    appShort: api
    deploymentDependsOn:
      - postgres
      - redis
    requires:
      - name: postgres
      - name: redis
    kedaScaleToZero:
      enabled: true
      minReplicaCount: 0
      maxReplicaCount: 5
      cooldownPeriod: 300
      pollingInterval: 30
    helm:
      type: install
      action: install
      repository: org/api-service
      branchName: feature-branch
      envLens: true
      grpc: false
      disableIngressHost: false
      overrideDefaultIpWhitelist: false
      chart:
        name: org-chart
        repoUrl: https://charts.example.com
        version: "2.1.0"
        valueFiles:
          - helm/api-values.yaml
          - helm/api-overrides.yaml
          - helm/api-secrets.yaml
        values:
          - "replicaCount=2"
          - "resources.requests.cpu=500m"
          - "resources.requests.memory=512Mi"
          - "resources.limits.cpu=1000m"
          - "resources.limits.memory=1024Mi"
          - "livenessProbe.httpGet.path=/health"
          - "livenessProbe.httpGet.port=8080"
          - "readinessProbe.httpGet.path=/ready"
          - "readinessProbe.httpGet.port=8080"
      docker:
        defaultTag: latest
        ecr: "123456789012.dkr.ecr.us-west-2.amazonaws.com/org/api"
        pipelineId: pipeline-api-build
        builder:
          engine: buildkit
          buildArgs:
            NODE_ENV: production
            BUILD_DATE: "2024-01-15"
        app:
          dockerfilePath: sysops/dockerfiles/api.dockerfile
          command: "node dist/server.js"
          arguments: "--max-old-space-size=4096"
          ports:
            - 8080
            - 9090
          env:
            NODE_ENV: production
            LOG_LEVEL: info
            DATABASE_URL: postgres://user:pass@db:5432/app
            REDIS_URL: redis://redis:6379
            API_SECRET_KEY: vault:secret/api-key
            CORS_ORIGIN: https://app.example.com
            RATE_LIMIT_MAX: "100"
            RATE_LIMIT_WINDOW: "60000"
          afterBuildPipelineConfig:
            afterBuildPipelineId: pipeline-api-post
            detatchAfterBuildPipeline: false
            description: "Run migrations after build"
        init:
          dockerfilePath: sysops/dockerfiles/init.dockerfile
          command: "node scripts/migrate.js"
          arguments: "--run-seeds"
          env:
            DATABASE_URL: postgres://user:pass@db:5432/app
            MIGRATION_DIR: ./migrations
  - name: web-app
    appShort: web
    deploymentDependsOn:
      - api-service
    helm:
      type: install
      action: install
      repository: org/web-app
      branchName: feature-branch
      envLens: true
      chart:
        name: org-chart
        repoUrl: https://charts.example.com
        version: "2.1.0"
        valueFiles:
          - helm/web-values.yaml
          - helm/web-ingress.yaml
        values:
          - "replicaCount=3"
          - "resources.requests.cpu=250m"
          - "resources.requests.memory=256Mi"
          - "resources.limits.cpu=500m"
          - "resources.limits.memory=512Mi"
          - "ingress.enabled=true"
          - "ingress.hosts[0].host=app.example.com"
      docker:
        defaultTag: latest
        ecr: "123456789012.dkr.ecr.us-west-2.amazonaws.com/org/web"
        builder:
          engine: buildkit
        app:
          dockerfilePath: Dockerfile
          ports:
            - 3000
          env:
            NEXT_PUBLIC_API_URL: /api
            NEXT_PUBLIC_WS_URL: wss://ws.example.com
            NODE_ENV: production
  - name: worker
    appShort: wrk
    deploymentDependsOn:
      - postgres
      - redis
    requires:
      - name: postgres
    kedaScaleToZero:
      enabled: true
      minReplicaCount: 0
      maxReplicaCount: 10
      cooldownPeriod: 600
    helm:
      type: install
      repository: org/api-service
      branchName: feature-branch
      chart:
        name: org-chart
        repoUrl: https://charts.example.com
        version: "2.1.0"
        valueFiles:
          - helm/worker-values.yaml
        values:
          - "replicaCount=1"
          - "resources.requests.cpu=1000m"
          - "resources.requests.memory=2048Mi"
      docker:
        defaultTag: latest
        ecr: "123456789012.dkr.ecr.us-west-2.amazonaws.com/org/worker"
        builder:
          engine: buildkit
        app:
          dockerfilePath: sysops/dockerfiles/worker.dockerfile
          command: "node dist/worker.js"
          env:
            WORKER_CONCURRENCY: "5"
            QUEUE_PREFIX: prod
            DATABASE_URL: postgres://user:pass@db:5432/app
            REDIS_URL: redis://redis:6379
  - name: postgres
    docker:
      dockerImage: postgres
      defaultTag: "14"
      command: "postgres"
      arguments: "-c shared_buffers=256MB -c max_connections=200"
      ports:
        - 5432
      env:
        POSTGRES_DB: myapp
        POSTGRES_USER: admin
        POSTGRES_PASSWORD: secret
        PGDATA: /var/lib/postgresql/data/pgdata
  - name: external-api
    externalHttp:
      defaultInternalHostname: api.partner.internal
      defaultPublicUrl: https://api.partner.example.com
`;

    it('achieves 2.5-8x compression on a realistic multi-service YAML', () => {
      const result = summarizeLifecycleYaml(realisticYaml);
      const rawTokens = countTokens(realisticYaml);
      const summaryTokens = countTokens(result.text);
      const ratio = rawTokens / summaryTokens;

      expect(result.parsed).toBe(true);
      expect(result.serviceCount).toBe(5);
      expect(ratio).toBeGreaterThanOrEqual(2.5);
      expect(ratio).toBeLessThanOrEqual(8);
    });

    it('summary is always smaller than raw YAML for multi-service files', () => {
      const result = summarizeLifecycleYaml(realisticYaml);
      expect(countTokens(result.text)).toBeLessThan(countTokens(realisticYaml));
    });
  });
});
