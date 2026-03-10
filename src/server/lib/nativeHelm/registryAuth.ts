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

export type RegistryAuthType = 'ecr';

export interface EcrRegistryAuth {
  type: 'ecr';
  registry: string;
  region: string;
}

export type RegistryAuthConfig = EcrRegistryAuth;

const ECR_OCI_PATTERN = /^oci:\/\/(\d+)\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\//;

export function detectRegistryAuth(chartRepoUrl?: string): RegistryAuthConfig | undefined {
  if (!chartRepoUrl?.startsWith('oci://')) return undefined;

  const match = chartRepoUrl.match(ECR_OCI_PATTERN);
  if (!match) return undefined;

  return {
    type: 'ecr',
    registry: `${match[1]}.dkr.ecr.${match[2]}.amazonaws.com`,
    region: match[2],
  };
}

export function createRegistryAuthInitContainer(auth: RegistryAuthConfig): any {
  switch (auth.type) {
    case 'ecr':
      return {
        name: 'ecr-auth',
        image: 'amazon/aws-cli:2.22.0',
        command: ['/bin/sh', '-c'],
        args: [
          `mkdir -p /workspace/.helm && aws ecr get-login-password --region ${auth.region} > /workspace/.helm/ecr-token`,
        ],
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
        volumeMounts: [{ name: 'helm-workspace', mountPath: '/workspace' }],
      };
  }
}

export function generateRegistryLoginScript(auth: RegistryAuthConfig): string {
  switch (auth.type) {
    case 'ecr':
      return `cat /workspace/.helm/ecr-token | helm registry login "${auth.registry}" --username AWS --password-stdin`;
  }
}
