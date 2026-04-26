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

import type { AgentRunStatus } from './types';

export class AgentRunOwnershipLostError extends Error {
  readonly runUuid: string;
  readonly expectedExecutionOwner: string;
  readonly currentStatus?: AgentRunStatus | null;
  readonly currentExecutionOwner?: string | null;

  constructor({
    runUuid,
    expectedExecutionOwner,
    currentStatus,
    currentExecutionOwner,
  }: {
    runUuid: string;
    expectedExecutionOwner: string;
    currentStatus?: AgentRunStatus | null;
    currentExecutionOwner?: string | null;
  }) {
    super(
      `Agent run execution ownership lost runUuid=${runUuid} expectedOwner=${expectedExecutionOwner} currentStatus=${
        currentStatus || 'unknown'
      } currentOwner=${currentExecutionOwner || 'none'}`
    );
    this.name = 'AgentRunOwnershipLostError';
    this.runUuid = runUuid;
    this.expectedExecutionOwner = expectedExecutionOwner;
    this.currentStatus = currentStatus;
    this.currentExecutionOwner = currentExecutionOwner;
  }
}
