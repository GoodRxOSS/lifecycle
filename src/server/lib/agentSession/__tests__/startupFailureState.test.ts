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

import { AppError } from 'server/lib/appError';
import {
  WORKSPACE_RUNTIME_FAILURE_STAGES,
  buildAgentSessionStartupFailure,
  buildWorkspaceRuntimeFailure,
  normalizeWorkspaceRuntimeFailure,
  toPublicAgentSessionStartupFailure,
  type WorkspaceRuntimeFailureStage,
} from '../startupFailureState';

describe('startupFailureState', () => {
  it('builds canonical workspace runtime failures with required public fields', () => {
    const failure = buildWorkspaceRuntimeFailure({
      error: new Error('Session workspace pod failed to start: init-workspace: ImagePullBackOff'),
      stage: 'connect_runtime',
      origin: 'agent_session',
      retryable: true,
    });

    expect(failure).toEqual(
      expect.objectContaining({
        stage: 'connect_runtime',
        title: 'Session workspace pod failed to start',
        message: 'init-workspace: ImagePullBackOff',
        retryable: true,
        origin: 'agent_session',
      })
    );
    expect(Date.parse(failure.recordedAt)).not.toBeNaN();
  });

  it('exports the exact workspace runtime failure stage taxonomy', () => {
    expect(WORKSPACE_RUNTIME_FAILURE_STAGES).toEqual([
      'create_session',
      'prepare_infrastructure',
      'connect_runtime',
      'attach_services',
      'suspend',
      'resume',
      'cleanup',
    ] satisfies WorkspaceRuntimeFailureStage[]);
  });

  it('keeps Redis startup failure compatibility with the canonical public shape', () => {
    const failure = buildAgentSessionStartupFailure({
      sessionId: 'session-1',
      error: new Error('service attach failed'),
      stage: 'attach_services',
    });

    expect(failure).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        stage: 'attach_services',
        title: 'Attached services failed to start',
        message: 'service attach failed',
        retryable: false,
        origin: 'agent_session',
      })
    );
    expect(toPublicAgentSessionStartupFailure(failure)).toEqual({
      stage: 'attach_services',
      title: 'Attached services failed to start',
      message: 'service attach failed',
      recordedAt: failure.recordedAt,
      retryable: false,
      origin: 'agent_session',
      code: 'workspace_attach_services_failed',
    });
  });

  it('sanitizes public title and message before persistence or API projection', () => {
    const failure = buildWorkspaceRuntimeFailure({
      error: new Error(
        [
          'Session workspace pod failed to start: init-workspace failed',
          'Authorization: Bearer sample-secret-token',
          'token=sample-token-value',
          'registryPassword=sample-registry-password',
          '-----BEGIN PRIVATE KEY-----sample-key-----END PRIVATE KEY-----',
          'at Object.<anonymous> (/workspace/sample-service/index.ts:12:3)',
          'raw pod log: npm ERR! command failed with sample output',
        ].join('\n')
      ),
    });

    const publicText = `${failure.title}\n${failure.message}`;
    expect(publicText).not.toContain('sample-secret-token');
    expect(publicText).not.toContain('token=sample-token-value');
    expect(publicText).not.toContain('sample-registry-password');
    expect(publicText).not.toContain('BEGIN PRIVATE KEY');
    expect(publicText).not.toContain('/workspace/sample-service/index.ts');
    expect(publicText).not.toContain('raw pod log');
    expect(publicText).not.toContain('npm ERR!');
  });

  it('redacts JSON and colon-delimited secret formats from public failures', () => {
    const failure = buildWorkspaceRuntimeFailure({
      error: new Error(
        [
          'Session workspace pod failed to start: init-workspace failed',
          '{"token":"sample-json-token","password":"sample-json-password","api_key":"sample-json-api-key"}',
          'password: sample-colon-password',
          'api_key: sample-colon-api-key',
        ].join('\n')
      ),
    });

    const publicText = `${failure.title}\n${failure.message}`;
    expect(publicText).not.toContain('sample-json-token');
    expect(publicText).not.toContain('sample-json-password');
    expect(publicText).not.toContain('sample-json-api-key');
    expect(publicText).not.toContain('sample-colon-password');
    expect(publicText).not.toContain('sample-colon-api-key');
    expect(publicText).toContain('"token": "[redacted]"');
    expect(publicText).toContain('"password": "[redacted]"');
    expect(publicText).toContain('"api_key": "[redacted]"');
    expect(publicText).toContain('password: [redacted]');
    expect(publicText).toContain('api_key: [redacted]');
  });

  it('redacts prefixed environment secret keys and Basic authorization headers', () => {
    const failure = buildWorkspaceRuntimeFailure({
      error: new Error(
        [
          'Session workspace pod failed to start: init-workspace failed',
          'GITHUB_TOKEN=sample-token',
          'OPENAI_API_KEY=sample-key',
          'AWS_SECRET_ACCESS_KEY=sample-secret',
          'Authorization: Basic sample-basic-token',
        ].join('\n')
      ),
    });

    const publicText = `${failure.title}\n${failure.message}`;
    expect(publicText).not.toContain('sample-token');
    expect(publicText).not.toContain('sample-key');
    expect(publicText).not.toContain('sample-secret');
    expect(publicText).not.toContain('sample-basic-token');
    expect(publicText).toContain('GITHUB_TOKEN=[redacted]');
    expect(publicText).toContain('OPENAI_API_KEY=[redacted]');
    expect(publicText).toContain('AWS_SECRET_ACCESS_KEY=[redacted]');
    expect(publicText).toContain('Authorization: [redacted]');
  });

  it('redacts long unterminated private-key blocks before truncating public failures', () => {
    const failure = buildWorkspaceRuntimeFailure({
      error: new Error(
        [
          'Session workspace pod failed to start:',
          '-----BEGIN PRIVATE KEY-----',
          'sample-private-key-material\n'.repeat(300),
        ].join('\n')
      ),
    });

    const publicText = `${failure.title}\n${failure.message}`;
    expect(publicText).toContain('[redacted private key]');
    expect(publicText).not.toContain('BEGIN PRIVATE KEY');
    expect(publicText).not.toContain('sample-private-key-material');
    expect(failure.message.length).toBeLessThanOrEqual(4000);
  });

  it('normalizes legacy and missing details to a stable failed-workspace object', () => {
    for (const detail of [{ message: 'Sandbox failed' }, 'Sandbox failed', null, undefined]) {
      expect(normalizeWorkspaceRuntimeFailure(detail)).toEqual(
        expect.objectContaining({
          stage: 'connect_runtime',
          title: 'Workspace could not be opened',
          message: 'Lifecycle could not open the workspace.',
          retryable: false,
          origin: 'legacy',
        })
      );
    }
  });

  it('derives a stable code per failure stage when the error is not an AppError', () => {
    expect(buildWorkspaceRuntimeFailure({ error: new Error('boom'), stage: 'connect_runtime' }).code).toBe(
      'workspace_connect_runtime_failed'
    );
    expect(buildWorkspaceRuntimeFailure({ error: new Error('boom'), stage: 'suspend' }).code).toBe(
      'workspace_suspend_failed'
    );
    // Default stage is connect_runtime when none is supplied.
    expect(buildWorkspaceRuntimeFailure({ error: new Error('boom') }).code).toBe('workspace_connect_runtime_failed');
  });

  it('propagates the originating AppError code and nextAction onto the durable failure', () => {
    const appError = new AppError({
      httpStatus: 503,
      code: 'session_workspace_gateway_unavailable',
      message: 'gateway unavailable',
      retryable: true,
      nextAction: { kind: 'reconnect', label: 'Reconnect workspace' },
    });

    const failure = buildWorkspaceRuntimeFailure({
      error: appError,
      stage: 'connect_runtime',
      origin: 'manual_runtime',
      retryable: true,
    });

    expect(failure.code).toBe('session_workspace_gateway_unavailable');
    expect(failure.nextAction).toEqual({ kind: 'reconnect', label: 'Reconnect workspace' });
  });

  it('lets an explicit code override the AppError code and stage default', () => {
    const failure = buildWorkspaceRuntimeFailure({
      error: new Error('Workspace startup timed out'),
      stage: 'connect_runtime',
      origin: 'chat_runtime',
      retryable: true,
      code: 'workspace_startup_timeout',
    });

    expect(failure.code).toBe('workspace_startup_timeout');
    expect(failure.retryable).toBe(true);
  });

  it('round-trips the code and nextAction through normalizeWorkspaceRuntimeFailure', () => {
    const built = buildWorkspaceRuntimeFailure({
      error: new AppError({
        httpStatus: 503,
        code: 'session_workspace_gateway_unavailable',
        message: 'gateway unavailable',
        nextAction: { kind: 'reconnect', label: 'Reconnect workspace' },
      }),
      stage: 'connect_runtime',
    });

    const normalized = normalizeWorkspaceRuntimeFailure(built);
    expect(normalized.code).toBe('session_workspace_gateway_unavailable');
    expect(normalized.nextAction).toEqual({ kind: 'reconnect', label: 'Reconnect workspace' });
  });
});
