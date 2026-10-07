/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Knex } from 'knex';

// PostgreSQL concurrent index operations cannot run inside Knex's migration transaction.
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Current readiness fetches active deployments by build ID. Keep historical rows out of this lookup index.
  await knex.raw('CREATE INDEX CONCURRENTLY deploys_active_build_id_idx ON deploys ("buildId") WHERE active = true');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY deploys_active_build_id_idx');
}
