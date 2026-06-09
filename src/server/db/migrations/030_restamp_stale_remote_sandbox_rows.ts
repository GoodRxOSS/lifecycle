/**
 * Copyright 2026 GoodRx, Inc.
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

import { Knex } from 'knex';

export const config = {
  transaction: true,
};

// A remote-stamped sandbox row whose providerState never recorded that backend's handle markers
// (the same fields each provider's hasPersistedHandle requires) describes a K8s workspace left by a
// failed remote attempt; suspend/teardown would no-op remotely and orphan the namespace/pod/PVC.
const REMOTE_HANDLE_MARKERS: Record<string, string[]> = {
  opensandbox: ['sandboxId', 'lifecycleBaseUrl'],
  modal: ['appName'],
  e2b: ['sandboxId', 'domain'],
  daytona: ['sandboxId', 'apiUrl'],
};

export async function up(knex: Knex): Promise<void> {
  for (const [provider, markers] of Object.entries(REMOTE_HANDLE_MARKERS)) {
    const missingMarker = markers.map((marker) => `NOT jsonb_exists("providerState", '${marker}')`).join(' OR ');
    const restamped = await knex('agent_sandboxes')
      .where({ provider })
      .whereRaw(`(${missingMarker})`)
      .whereRaw(
        `(jsonb_exists("providerState", 'podName') OR EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = agent_sandboxes."sessionId" AND s.namespace IS NOT NULL))`
      )
      .update({ provider: 'lifecycle_kubernetes' })
      .returning('id');
    if (restamped.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `030: restamped ${restamped.length} ${provider} sandbox row(s) to lifecycle_kubernetes ids=${restamped
          .map((row) => (typeof row === 'object' ? row.id : row))
          .join(',')}`
      );
    }
  }
}

// The old stamps were wrong; there is nothing to restore.
export async function down(): Promise<void> {}
