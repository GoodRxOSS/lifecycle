/**
 * Copyright 2026 Lifecycle contributors
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

import { serializeAgentSessionSummary } from '../serializeSessionSummary';

describe('serializeAgentSessionSummary', () => {
  it('uses the public UUID, removes internal fields, and exposes the editor for a ready workspace', () => {
    const result = serializeAgentSessionSummary({
      id: 42,
      uuid: 'session-uuid',
      skillPlan: { internal: true },
      podName: 'agent-pod',
      namespace: 'agent-session-uuid',
      status: 'READY',
    });

    expect(result).toEqual({
      id: 'session-uuid',
      podName: 'agent-pod',
      namespace: 'agent-session-uuid',
      status: 'READY',
      editorUrl: '/api/agent-session/workspace-editor/session-uuid/',
    });
    expect(result).not.toHaveProperty('skillPlan');
    expect(result).not.toHaveProperty('uuid');
  });

  const fallbackCases: Array<
    [string, { id: string | number; uuid?: string | null; podName?: string; namespace?: string }, string]
  > = [
    ['a missing UUID', { id: 7 }, '7'],
    ['a null UUID', { id: 8, uuid: null, podName: 'pod-only' }, '8'],
    ['an empty UUID', { id: 'internal-id', uuid: '', namespace: 'namespace-only' }, 'internal-id'],
  ];

  it.each(fallbackCases)(
    'falls back to the internal id for %s without exposing a partial editor URL',
    (_name, session, expectedId) => {
      expect(serializeAgentSessionSummary(session)).toEqual(
        expect.objectContaining({
          id: expectedId,
          podName: session.podName ?? null,
          namespace: session.namespace ?? null,
          editorUrl: null,
        })
      );
    }
  );
});
