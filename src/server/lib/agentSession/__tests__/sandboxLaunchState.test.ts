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

import { toPublicSandboxLaunchState } from '../sandboxLaunchState';

describe('sandboxLaunchState', () => {
  it('fills nullable launch fields with null for queued launches', () => {
    expect(
      toPublicSandboxLaunchState({
        launchId: 'launch-1',
        userId: 'user-1',
        status: 'queued',
        stage: 'queued',
        message: 'Queued sandbox launch',
        createdAt: '2026-04-06T00:00:00.000Z',
        updatedAt: '2026-04-06T00:00:00.000Z',
        baseBuildUuid: 'build-1',
        service: 'frontend',
      })
    ).toEqual({
      launchId: 'launch-1',
      status: 'queued',
      stage: 'queued',
      message: 'Queued sandbox launch',
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:00:00.000Z',
      baseBuildUuid: 'build-1',
      service: 'frontend',
      buildUuid: null,
      namespace: null,
      sessionId: null,
      focusUrl: null,
      error: null,
    });
  });

  it('preserves launch fields when they are present', () => {
    expect(
      toPublicSandboxLaunchState({
        launchId: 'launch-1',
        userId: 'user-1',
        status: 'created',
        stage: 'ready',
        message: 'Sandbox session is ready',
        createdAt: '2026-04-06T00:00:00.000Z',
        updatedAt: '2026-04-06T00:01:00.000Z',
        baseBuildUuid: 'build-1',
        service: 'frontend',
        buildUuid: 'sandbox-build-1',
        namespace: 'sbx-abc123',
        sessionId: 'session-1',
        focusUrl: '/environments/sandbox-build-1/agent-session/session-1',
        error: null,
      })
    ).toEqual({
      launchId: 'launch-1',
      status: 'created',
      stage: 'ready',
      message: 'Sandbox session is ready',
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:01:00.000Z',
      baseBuildUuid: 'build-1',
      service: 'frontend',
      buildUuid: 'sandbox-build-1',
      namespace: 'sbx-abc123',
      sessionId: 'session-1',
      focusUrl: '/environments/sandbox-build-1/agent-session/session-1',
      error: null,
    });
  });
});
