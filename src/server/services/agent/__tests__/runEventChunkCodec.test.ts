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

import { toChunkEvents, chunkFromEvent } from '../runEventChunkCodec';
import type { AgentUiMessageChunk } from '../streamChunks';

describe('runEventChunkCodec approval round-trip', () => {
  it('persists isAutomatic and signature on approval requests and restores them on replay', () => {
    const chunk = {
      type: 'tool-approval-request',
      approvalId: 'approval-1',
      toolCallId: 'call-1',
      isAutomatic: true,
      signature: 'sig-1',
    } as unknown as AgentUiMessageChunk;

    const events = toChunkEvents(chunk);
    expect(events).toEqual([
      {
        eventType: 'approval.requested',
        payload: expect.objectContaining({
          approvalId: 'approval-1',
          toolCallId: 'call-1',
          isAutomatic: true,
          signature: 'sig-1',
        }),
      },
    ]);

    const replayed = chunkFromEvent({ eventType: 'approval.requested', payload: events[0].payload } as never);
    expect(replayed).toEqual(
      expect.objectContaining({
        type: 'tool-approval-request',
        approvalId: 'approval-1',
        toolCallId: 'call-1',
        isAutomatic: true,
        signature: 'sig-1',
      })
    );
  });

  it('persists in-stream auto-approval responses so replays do not show phantom pending approvals', () => {
    const chunk = {
      type: 'tool-approval-response',
      approvalId: 'approval-1',
      approved: true,
      isAutomatic: true,
    } as unknown as AgentUiMessageChunk;

    const events = toChunkEvents(chunk);
    expect(events).toEqual([
      {
        eventType: 'approval.responded',
        payload: expect.objectContaining({
          approvalId: 'approval-1',
          approved: true,
          isAutomatic: true,
        }),
      },
    ]);
  });

  it('replays approval.responded events (manual or automatic) as tool-approval-response chunks', () => {
    const replayed = chunkFromEvent({
      eventType: 'approval.responded',
      payload: { approvalId: 'approval-1', toolCallId: 'call-1', approved: false, reason: 'Not needed' },
    } as never);

    expect(replayed).toEqual(
      expect.objectContaining({
        type: 'tool-approval-response',
        approvalId: 'approval-1',
        approved: false,
        reason: 'Not needed',
      })
    );
  });

  it('drops malformed approval.responded events instead of emitting invalid chunks', () => {
    expect(chunkFromEvent({ eventType: 'approval.responded', payload: { approvalId: 'a' } } as never)).toBeNull();
    expect(chunkFromEvent({ eventType: 'approval.responded', payload: { approved: true } } as never)).toBeNull();
  });
});

// Mirrors chunk-from-event.parity.test.ts in lifecycle-ui — the two folds are declared byte-identical.
describe('runEventChunkCodec UI-parity fixtures', () => {
  it('parity: run.failed with token-budget details interpolates the budget', () => {
    expect(
      chunkFromEvent({
        eventType: 'run.failed',
        payload: {
          status: 'failed',
          error: {
            code: 'run_token_budget_exceeded',
            message: 'Run input token budget exceeded.',
            details: { maxRunInputTokens: 400000 },
          },
        },
      } as never)
    ).toEqual({
      type: 'error',
      errorText:
        'The agent used its 400,000-token input budget for this response. Send a follow-up to continue with a fresh budget.',
    });
  });

  it('parity: approval.requested keeps isAutomatic and signature', () => {
    expect(
      chunkFromEvent({
        eventType: 'approval.requested',
        payload: { approvalId: 'approval-1', toolCallId: 'tc-1', isAutomatic: true, signature: 'sig-1' },
      } as never)
    ).toEqual({
      type: 'tool-approval-request',
      approvalId: 'approval-1',
      toolCallId: 'tc-1',
      isAutomatic: true,
      signature: 'sig-1',
    });
  });

  it('parity: approval.responded folds as a tool-approval-response', () => {
    expect(
      chunkFromEvent({
        eventType: 'approval.responded',
        payload: { approvalId: 'approval-1', toolCallId: 'tc-1', approved: false, reason: 'Not needed' },
      } as never)
    ).toEqual({
      type: 'tool-approval-response',
      approvalId: 'approval-1',
      approved: false,
      reason: 'Not needed',
    });
  });

  it('parity: run.transitioned folds as a finish chunk with transition metadata', () => {
    expect(
      chunkFromEvent({
        eventType: 'run.transitioned',
        payload: {
          status: 'transitioned',
          transition: { label: 'Continuing in workspace', status: 'Setting up workspace' },
        },
      } as never)
    ).toEqual({
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: {
        transition: { label: 'Continuing in workspace', status: 'Setting up workspace' },
      },
    });
  });
});
