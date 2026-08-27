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

import type { Redis } from 'ioredis';
import {
  buildSandboxFocusUrl,
  getSandboxLaunchState,
  patchSandboxLaunchState,
  setSandboxLaunchState,
  toPublicSandboxLaunchState,
} from '../sandboxLaunchState';

describe('sandboxLaunchState', () => {
  const get = jest.fn();
  const setex = jest.fn();
  const redis = { get, setex } as unknown as Redis;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds the sandbox focus URL with an encoded base-build identity', () => {
    expect(
      buildSandboxFocusUrl({
        buildUuid: 'sandbox-build-1',
        sessionId: 'session-1',
        baseBuildUuid: 'base/build 1',
      })
    ).toBe('/environments/sandbox-build-1/agent-session/session-1?baseBuildUuid=base%2Fbuild+1');
  });

  it('persists launch state under the launch key with the one-hour TTL', async () => {
    const state = {
      launchId: 'launch-1',
      userId: 'user-1',
      status: 'queued' as const,
      stage: 'queued' as const,
      message: 'Queued sandbox launch',
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:00:00.000Z',
    };

    await setSandboxLaunchState(redis, state);

    expect(setex).toHaveBeenCalledWith('lifecycle:agent:sandbox-launch:launch-1', 3600, JSON.stringify(state));
  });

  it.each([
    ['an absent value', null],
    ['malformed JSON', '{not-json'],
  ])('returns null for %s in Redis', async (_label, raw) => {
    get.mockResolvedValue(raw);

    await expect(getSandboxLaunchState(redis, 'launch-1')).resolves.toBeNull();
  });

  it('returns null without writing when a launch disappears before patching', async () => {
    get.mockResolvedValue(null);

    await expect(patchSandboxLaunchState(redis, 'launch-1', { stage: 'ready' })).resolves.toBeNull();
    expect(setex).not.toHaveBeenCalled();
  });

  it('normalizes a stored launch and persists an updated patch', async () => {
    get.mockResolvedValue(
      JSON.stringify({
        launchId: 'launch-1',
        userId: 'user-1',
        status: 'running',
        stage: 'opening_session',
        message: 'Opening session',
        createdAt: '2026-04-06T00:00:00.000Z',
        updatedAt: '2026-04-06T00:00:30.000Z',
      })
    );
    jest.useFakeTimers().setSystemTime(new Date('2026-04-06T00:01:00.000Z'));

    try {
      const updated = await patchSandboxLaunchState(redis, 'launch-1', {
        status: 'created',
        stage: 'ready',
        message: 'Sandbox session is ready',
        sessionId: 'session-1',
      });

      expect(updated).toEqual(
        expect.objectContaining({
          launchId: 'launch-1',
          status: 'created',
          stage: 'ready',
          sessionId: 'session-1',
          buildUuid: null,
          namespace: null,
          focusUrl: null,
          error: null,
          workspaceFailure: null,
          updatedAt: '2026-04-06T00:01:00.000Z',
        })
      );
      expect(setex).toHaveBeenCalledWith('lifecycle:agent:sandbox-launch:launch-1', 3600, JSON.stringify(updated));
    } finally {
      jest.useRealTimers();
    }
  });

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
      workspaceFailure: null,
    });
  });

  it('preserves launch fields when they are present', () => {
    const workspaceFailure = {
      stage: 'connect_runtime',
      title: 'Workspace did not start',
      message: 'workspace pod failed',
      recordedAt: '2026-04-06T00:00:30.000Z',
      retryable: false,
      origin: 'sandbox_launch',
    } as const;

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
        workspaceFailure,
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
      workspaceFailure,
    });
  });
});
