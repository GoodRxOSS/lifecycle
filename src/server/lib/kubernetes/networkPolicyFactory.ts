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

import { V1NetworkPolicy } from '@kubernetes/client-node';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';

export function buildAgentNetworkPolicy(namespace: string): V1NetworkPolicy {
  return {
    metadata: {
      name: 'lifecycle-agent-egress',
      namespace,
      labels: {
        ...buildLifecycleLabels(),
        'app.kubernetes.io/component': 'agent',
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          'app.kubernetes.io/component': 'agent-session',
        },
      },
      policyTypes: ['Egress'],
      egress: [
        {
          ports: [
            { port: 53, protocol: 'UDP' },
            { port: 53, protocol: 'TCP' },
          ],
          to: [],
        },
        {
          ports: [{ port: 443, protocol: 'TCP' }],
          to: [
            {
              ipBlock: {
                cidr: '0.0.0.0/0',
                except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'],
              },
            },
          ],
        },
      ],
    },
  };
}
