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

/**
 * CONTRACT TEST — runs the REAL ai-sdk validator (no mocks) over every tool-part shape the run
 * pipeline can persist, replayed against a ToolSet that may no longer contain the tool. Input
 * validation is fail-closed at resume (`run_resume_state_invalid` kills the run with a user-facing
 * error), so any persisted shape that fails here is a production resume-break: fix it by extending
 * normalizeUnavailableToolPartsForAgentInput, then encode the shape in this matrix.
 */
import {
  normalizeUnavailableToolPartsForAgentInput,
  projectSystemEventMessagesForAgentInput,
} from '../agentInputNormalization';
import type { AgentUIMessage } from '../types';

type PartShape = Record<string, unknown>;

const KNOWN_TOOL = 'known_tool';
const VANISHED_TOOL = 'vanished_tool';

// Every persistable invocation shape, keyed by the lifecycle that produces it. `approval: { id }`
// (no decision) is the server-side auto-approval stamp; output-* shapes must survive it.
const INVOCATION_SHAPES: Array<{ name: string; shape: PartShape }> = [
  { name: 'input-available', shape: { state: 'input-available', input: { arg: 'value' } } },
  {
    name: 'approval-requested',
    shape: { state: 'approval-requested', input: { arg: 'value' }, approval: { id: 'approval-1' } },
  },
  {
    name: 'approval-responded approved',
    shape: {
      state: 'approval-responded',
      input: { arg: 'value' },
      approval: { id: 'approval-1', approved: true },
    },
  },
  {
    name: 'approval-responded denied',
    shape: {
      state: 'approval-responded',
      input: { arg: 'value' },
      approval: { id: 'approval-1', approved: false, reason: 'no' },
    },
  },
  { name: 'output-available without approval', shape: { state: 'output-available', input: {}, output: { ok: true } } },
  {
    name: 'output-available with resolved approval',
    shape: {
      state: 'output-available',
      input: {},
      output: { ok: true },
      approval: { id: 'approval-1', approved: true },
    },
  },
  {
    name: 'output-available with auto-approval stamp (id only)',
    shape: { state: 'output-available', input: {}, output: { ok: true }, approval: { id: 'approval-1' } },
  },
  {
    name: 'output-available with automatic stamp',
    shape: {
      state: 'output-available',
      input: {},
      output: { ok: true },
      approval: { id: 'approval-1', isAutomatic: true },
    },
  },
  {
    name: 'output-available missing input (rawInput only)',
    shape: { state: 'output-available', rawInput: { arg: 'raw' }, output: { ok: true } },
  },
  { name: 'output-error', shape: { state: 'output-error', input: {}, errorText: 'boom' } },
  {
    name: 'output-error missing input (rawInput only)',
    shape: { state: 'output-error', rawInput: { arg: 'raw' }, errorText: 'boom' },
  },
  {
    name: 'output-error with auto-approval stamp (id only)',
    shape: { state: 'output-error', input: {}, errorText: 'boom', approval: { id: 'approval-1' } },
  },
  {
    name: 'output-denied with resolved approval',
    shape: { state: 'output-denied', input: {}, approval: { id: 'approval-1', approved: false } },
  },
  {
    name: 'output-denied with auto-denial stamp (id only)',
    shape: { state: 'output-denied', input: {}, approval: { id: 'approval-1' } },
  },
];

const PART_KINDS: Array<{ name: string; buildPart: (shape: PartShape) => PartShape }> = [
  {
    name: `static part for registered tool ${KNOWN_TOOL}`,
    buildPart: (shape) => ({ type: `tool-${KNOWN_TOOL}`, toolCallId: 'call-1', ...shape }),
  },
  {
    name: `static part for vanished tool ${VANISHED_TOOL}`,
    buildPart: (shape) => ({ type: `tool-${VANISHED_TOOL}`, toolCallId: 'call-1', ...shape }),
  },
  {
    name: 'dynamic part',
    buildPart: (shape) => ({
      type: 'dynamic-tool',
      toolName: 'mcp__someserver__sometool',
      toolCallId: 'call-1',
      ...shape,
    }),
  },
];

function buildMessage(part: PartShape): AgentUIMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'working on it' }, part],
  } as unknown as AgentUIMessage;
}

describe('agent input normalization contract (real ai-sdk validator)', () => {
  let safeValidateUIMessages: typeof import('ai').safeValidateUIMessages;
  let toolSet: Record<string, unknown>;

  beforeAll(async () => {
    const ai = await import('ai');
    safeValidateUIMessages = ai.safeValidateUIMessages;
    toolSet = {
      [KNOWN_TOOL]: ai.tool({
        description: 'a registered tool',
        inputSchema: ai.jsonSchema({ type: 'object', additionalProperties: true }),
      }),
    };
  });

  for (const kind of PART_KINDS) {
    for (const invocation of INVOCATION_SHAPES) {
      it(`${kind.name} in state ${invocation.name} validates after normalization`, async () => {
        const message = buildMessage(kind.buildPart(invocation.shape));

        const normalized = normalizeUnavailableToolPartsForAgentInput([message], toolSet as never);
        const validation = await safeValidateUIMessages({
          messages: normalized,
          tools: toolSet as never,
        });

        if (!validation.success) {
          throw new Error(
            `Validation failed: ${validation.error?.message}\nNormalized part: ${JSON.stringify(
              normalized[0]?.parts?.[1],
              null,
              2
            )}`
          );
        }
      });
    }
  }

  it('replayed canonical tool_call parts round-trip through UI conversion, normalization, and validation', async () => {
    const { toUiMessageFromCanonicalInput } = await import('../canonicalMessages');
    const canonicalParts = [
      {
        type: 'tool_call' as const,
        toolName: KNOWN_TOOL,
        toolCallId: 'call-completed',
        state: 'completed' as const,
        input: JSON.stringify({ file_path: 'lifecycle.yaml' }),
        output: 'file contents preview',
      },
      {
        type: 'tool_call' as const,
        toolName: VANISHED_TOOL,
        toolCallId: 'call-error',
        state: 'error' as const,
        input: JSON.stringify({ arg: 1 }),
        output: 'Error: it broke',
      },
      {
        type: 'tool_call' as const,
        toolName: KNOWN_TOOL,
        toolCallId: 'call-denied',
        state: 'denied' as const,
        input: 'not json',
        output: null,
        approval: { id: 'approval-9', approved: false, reason: 'not now' },
      },
    ];

    const replayed = toUiMessageFromCanonicalInput({
      id: 'assistant-replayed',
      role: 'assistant',
      parts: [{ type: 'text', text: 'earlier turn' }, ...canonicalParts],
    });

    const normalized = normalizeUnavailableToolPartsForAgentInput([replayed], toolSet as never);
    const validation = await safeValidateUIMessages({ messages: normalized, tools: toolSet as never });
    if (!validation.success) {
      throw new Error(
        `Validation failed: ${validation.error?.message}\nParts: ${JSON.stringify(normalized[0]?.parts, null, 2)}`
      );
    }
  });

  it('projects non-tool canonical parts (source_ref, file_ref, denied) to valid UI parts', async () => {
    const { toUiMessageFromCanonicalInput } = await import('../canonicalMessages');
    type CanonicalPart = Parameters<typeof toUiMessageFromCanonicalInput>[0]['parts'][number];

    const canonicalParts: CanonicalPart[] = [
      { type: 'source_ref', url: 'https://example.com', title: 'Example' },
      { type: 'source_ref', url: 'https://example.com', title: null, sourceId: 'src-1' },
      { type: 'source_ref', url: null, title: 'A document', sourceType: 'document' },
      { type: 'file_ref', path: 'notes.txt', url: null, mediaType: null, title: null },
      { type: 'file_ref', path: null, url: 'https://example.com/notes.txt', mediaType: null, title: null },
      { type: 'file_ref', path: null, url: 'https://example.com/n.txt', mediaType: 'text/plain', title: 'n' },
      {
        type: 'tool_call',
        toolName: KNOWN_TOOL,
        toolCallId: 'call-denied-noid',
        state: 'denied',
        input: null,
        output: null,
        approval: null,
      },
    ];

    const replayed = toUiMessageFromCanonicalInput({
      id: 'assistant-non-tool',
      role: 'assistant',
      parts: [{ type: 'text', text: 'earlier turn' }, ...canonicalParts],
    });

    const normalized = normalizeUnavailableToolPartsForAgentInput([replayed], toolSet as never);
    const validation = await safeValidateUIMessages({ messages: normalized, tools: toolSet as never });
    if (!validation.success) {
      throw new Error(
        `Validation failed: ${validation.error?.message}\nParts: ${JSON.stringify(replayed.parts, null, 2)}`
      );
    }
  });

  it('projects system-event rows to user-role conversation notes that the SDK prompt accepts', async () => {
    const systemMessage = {
      id: 'system-event-1',
      role: 'system',
      parts: [
        { type: 'text', text: 'You changed the available tools: disabled Source control. Applies to future runs.' },
      ],
      metadata: { kind: 'runtime_controls_update' },
    } as unknown as AgentUIMessage;

    const projected = projectSystemEventMessagesForAgentInput([systemMessage]);
    expect(projected[0].role).toBe('user');
    expect((projected[0].parts[0] as { text: string }).text).toBe(
      '[Conversation event] You changed the available tools: disabled Source control. Applies to future runs.'
    );

    const validation = await safeValidateUIMessages({ messages: projected, tools: toolSet as never });
    expect(validation.success).toBe(true);

    // ai's standardizePrompt rejects role:'system' in messages — convertToModelMessages of the raw row
    // is exactly the AI_InvalidPromptError seen live, so the projection must always run before input.
    const ai = await import('ai');
    const modelMessages = await ai.convertToModelMessages(projected);
    expect(modelMessages[0].role).toBe('user');
  });

  it('accepts raw system-event rows in UI-message validation so the persistence baseline can keep them unprojected', async () => {
    const systemMessage = {
      id: 'system-event-2',
      role: 'system',
      parts: [{ type: 'text', text: 'Environment state — as of now (run start)' }],
      metadata: { kind: 'environment_state' },
    } as unknown as AgentUIMessage;

    // The harness validates agentInputMessages BEFORE projecting; system rows must pass as-is.
    const validation = await safeValidateUIMessages({ messages: [systemMessage], tools: toolSet as never });
    expect(validation.success).toBe(true);
  });

  it('leaves already-valid messages untouched (same reference, no copies)', () => {
    const message = buildMessage({
      type: `tool-${KNOWN_TOOL}`,
      toolCallId: 'call-1',
      state: 'output-available',
      input: {},
      output: { ok: true },
    });

    const normalized = normalizeUnavailableToolPartsForAgentInput([message], toolSet as never);
    expect(normalized[0]).toBe(message);
  });

  it('quarantines only the invalid part instead of dropping the whole message', async () => {
    const { quarantineInvalidMessagesForAgentInput } = await import('../LifecycleAiSdkHarness');
    const goodMessage = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as unknown as AgentUIMessage;
    const poisonedMessage = {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'answer' },
        { type: 'file', filename: 'notes.txt' }, // invalid: ai@7 file part requires url + mediaType
      ],
    } as unknown as AgentUIMessage;

    const result = await quarantineInvalidMessagesForAgentInput(
      [goodMessage, poisonedMessage],
      toolSet as never,
      safeValidateUIMessages
    );

    expect(result).not.toBeNull();
    const validation = await safeValidateUIMessages({ messages: result!, tools: toolSet as never });
    expect(validation.success).toBe(true);
    expect(result).toHaveLength(2);
    expect(result![1].parts).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('returns null from quarantine when every message is already valid', async () => {
    const { quarantineInvalidMessagesForAgentInput } = await import('../LifecycleAiSdkHarness');
    const message = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as unknown as AgentUIMessage;
    const result = await quarantineInvalidMessagesForAgentInput([message], toolSet as never, safeValidateUIMessages);
    expect(result).toBeNull();
  });
});
