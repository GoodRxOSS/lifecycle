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

// SECURITY: legacy exposure rows (preview and editor) persisted plaintext auth headers; both proxies
// now resolve auth fresh from the sandbox row per request, so the at-rest copies are pure liability.
export async function up(knex: Knex): Promise<void> {
  await knex('agent_sandbox_exposures')
    .whereRaw(`jsonb_exists("providerState", 'headers')`)
    .update({ providerState: knex.raw(`"providerState" - 'headers'`) });
}

// The stripped credentials are not recoverable and must not be restored.
export async function down(): Promise<void> {}
