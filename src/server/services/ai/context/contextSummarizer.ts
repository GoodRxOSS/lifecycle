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

import yaml from 'js-yaml';

export interface LifecycleYamlSummary {
  text: string;
  parsed: boolean;
  serviceCount: number;
}

const SERVICE_TYPE_KEYS = [
  'helm',
  'codefresh',
  'github',
  'docker',
  'externalHttp',
  'auroraRestore',
  'configuration',
] as const;

function extractServiceType(svc: Record<string, any>): string {
  for (const key of SERVICE_TYPE_KEYS) {
    if (svc[key] != null) return key;
  }
  return 'unknown';
}

function formatRepo(block: Record<string, any>): string | null {
  if (!block.repository) return null;
  return block.branchName ? `${block.repository} @ ${block.branchName}` : block.repository;
}

function extractDependencies(svc: Record<string, any>): string[] {
  const deps: string[] = [];
  if (Array.isArray(svc.deploymentDependsOn)) {
    deps.push(...svc.deploymentDependsOn);
  }
  if (Array.isArray(svc.requires)) {
    for (const req of svc.requires) {
      if (req?.name) deps.push(req.name);
    }
  }
  return deps;
}

function extractHelmLines(block: Record<string, any>, lines: string[], referencedFiles: string[]): void {
  const repo = formatRepo(block);
  if (repo) lines.push(`  Repo: ${repo}`);

  if (block.chart) {
    let chartLine = `  Chart: ${block.chart.name}`;
    if (block.chart.repoUrl) chartLine += ` (repoUrl: ${block.chart.repoUrl})`;
    if (block.chart.version) chartLine += ` (version: ${block.chart.version})`;
    lines.push(chartLine);

    if (Array.isArray(block.chart.valueFiles) && block.chart.valueFiles.length) {
      lines.push(`  ValueFiles: ${block.chart.valueFiles.join(', ')}`);
      referencedFiles.push(...block.chart.valueFiles);
    }
  }

  const dockerfilePath = block.docker?.app?.dockerfilePath;
  const engine = block.docker?.builder?.engine;
  if (dockerfilePath) {
    const dockerLine = engine
      ? `  Docker: ${engine} | dockerfilePath: ${dockerfilePath}`
      : `  Docker: dockerfilePath: ${dockerfilePath}`;
    lines.push(dockerLine);
    referencedFiles.push(dockerfilePath);
  }

  const ports = block.docker?.app?.ports;
  if (Array.isArray(ports) && ports.length) {
    lines.push(`  Ports: ${ports.join(', ')}`);
  }
}

function extractCodefreshLines(block: Record<string, any>, lines: string[]): void {
  const repo = formatRepo(block);
  if (repo) lines.push(`  Repo: ${repo}`);

  if (block.deploy?.pipelineId) {
    lines.push(`  Pipeline: ${block.deploy.pipelineId}`);
  }
}

function extractGithubLines(block: Record<string, any>, lines: string[], referencedFiles: string[]): void {
  const repo = formatRepo(block);
  if (repo) lines.push(`  Repo: ${repo}`);

  const dockerfilePath = block.docker?.app?.dockerfilePath;
  const engine = block.docker?.builder?.engine;
  if (dockerfilePath) {
    const dockerLine = engine
      ? `  Docker: ${engine} | dockerfilePath: ${dockerfilePath}`
      : `  Docker: dockerfilePath: ${dockerfilePath}`;
    lines.push(dockerLine);
    referencedFiles.push(dockerfilePath);
  }
}

function extractDockerLines(block: Record<string, any>, lines: string[]): void {
  if (block.dockerImage) {
    const image = block.defaultTag ? `${block.dockerImage}:${block.defaultTag}` : block.dockerImage;
    lines.push(`  Image: ${image}`);
  }

  if (Array.isArray(block.ports) && block.ports.length) {
    lines.push(`  Ports: ${block.ports.join(', ')}`);
  }
}

function extractExternalHttpLines(block: Record<string, any>, lines: string[]): void {
  if (block.defaultInternalHostname) {
    lines.push(`  InternalHost: ${block.defaultInternalHostname}`);
  }
  if (block.defaultPublicUrl) {
    lines.push(`  PublicUrl: ${block.defaultPublicUrl}`);
  }
}

function extractAuroraRestoreLines(block: Record<string, any>, lines: string[]): void {
  if (block.command) lines.push(`  Command: ${block.command}`);
  if (block.arguments) lines.push(`  Arguments: ${block.arguments}`);
}

function extractConfigurationLines(block: Record<string, any>, lines: string[]): void {
  if (block.defaultTag) lines.push(`  DefaultTag: ${block.defaultTag}`);
  if (block.branchName) lines.push(`  Branch: ${block.branchName}`);
}

export function summarizeLifecycleYaml(rawYaml: string): LifecycleYamlSummary {
  try {
    const doc = yaml.load(rawYaml) as Record<string, any>;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { text: rawYaml, parsed: false, serviceCount: 0 };
    }

    const lines: string[] = [];

    if (doc.environment || doc.version) {
      lines.push('ENVIRONMENT:');
      if (doc.version) lines.push(`  Version: ${doc.version}`);
      if (doc.environment) {
        if (doc.environment.autoDeploy !== undefined) {
          lines.push(`  AutoDeploy: ${doc.environment.autoDeploy}`);
        }
        if (Array.isArray(doc.environment.enabledFeatures) && doc.environment.enabledFeatures.length) {
          lines.push(`  EnabledFeatures: ${doc.environment.enabledFeatures.join(', ')}`);
        }
        if (Array.isArray(doc.environment.defaultServices) && doc.environment.defaultServices.length) {
          lines.push(`  Default Services: ${doc.environment.defaultServices.map((s: any) => s.name).join(', ')}`);
        }
        if (Array.isArray(doc.environment.optionalServices) && doc.environment.optionalServices.length) {
          lines.push(`  Optional Services: ${doc.environment.optionalServices.map((s: any) => s.name).join(', ')}`);
        }
      }
      lines.push('');
    }

    const services = Array.isArray(doc.services) ? doc.services : [];
    const referencedFiles: string[] = [];

    lines.push(`SERVICES (${services.length}):`);
    lines.push('');

    if (services.length > 30) {
      const typeCounts = new Map<string, number>();
      const servicesWithDeps: Array<{ name: string; type: string; deps: string[] }> = [];

      for (const svc of services) {
        const type = extractServiceType(svc);
        typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
        const deps = extractDependencies(svc);
        if (deps.length > 0) {
          servicesWithDeps.push({ name: svc.name, type, deps });
        }
      }

      const typeBreakdown = [...typeCounts.entries()].map(([type, count]) => `${count} ${type}`).join(', ');
      lines.push(`Types: ${typeBreakdown}`);
      lines.push('');

      if (servicesWithDeps.length > 0) {
        lines.push(`Services with dependencies (${servicesWithDeps.length}):`);
        for (const svc of servicesWithDeps) {
          lines.push(`  ${svc.name} (${svc.type}) → DependsOn: ${svc.deps.join(', ')}`);
        }
        lines.push('');
      }

      lines.push('[Use get_file("lifecycle.yaml") for full service details]');
      lines.push('');
    } else {
      services.forEach((svc: any, i: number) => {
        const type = extractServiceType(svc);
        const serviceLines: string[] = [];
        serviceLines.push(`[${i + 1}] ${svc.name} (${type})`);

        const block = svc[type];
        if (block && typeof block === 'object') {
          switch (type) {
            case 'helm':
              extractHelmLines(block, serviceLines, referencedFiles);
              break;
            case 'codefresh':
              extractCodefreshLines(block, serviceLines);
              break;
            case 'github':
              extractGithubLines(block, serviceLines, referencedFiles);
              break;
            case 'docker':
              extractDockerLines(block, serviceLines);
              break;
            case 'externalHttp':
              extractExternalHttpLines(block, serviceLines);
              break;
            case 'auroraRestore':
              extractAuroraRestoreLines(block, serviceLines);
              break;
            case 'configuration':
              extractConfigurationLines(block, serviceLines);
              break;
          }
        }

        const deps = extractDependencies(svc);
        if (deps.length) {
          serviceLines.push(`  DependsOn: ${deps.join(', ')}`);
        }

        lines.push(...serviceLines);
        lines.push('');
      });
    }

    const uniqueFiles = [...new Set(referencedFiles)];
    if (uniqueFiles.length) {
      lines.push('CONFIG POINTERS:');
      lines.push(`  Referenced Files: ${uniqueFiles.join(', ')}`);
    }

    return {
      text: lines.join('\n'),
      parsed: true,
      serviceCount: services.length,
    };
  } catch {
    return { text: rawYaml, parsed: false, serviceCount: 0 };
  }
}
