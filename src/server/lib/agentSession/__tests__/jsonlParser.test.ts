/**
 * Copyright 2025 GoodRx, Inc.
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

import { AgentWSServerMessage } from 'shared/types/agentSession';
import { JsonlParser } from '../jsonlParser';

describe('JsonlParser', () => {
  let messages: AgentWSServerMessage[];
  let parser: JsonlParser;

  beforeEach(() => {
    messages = [];
    parser = new JsonlParser((msg) => messages.push(msg));
  });

  it('parses a complete JSONL line', () => {
    parser.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'chunk', content: 'hello' });
  });

  it('buffers partial lines until newline', () => {
    parser.feed('{"type":"assis');
    expect(messages).toHaveLength(0);

    parser.feed('tant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'chunk', content: 'hi' });
  });

  it('handles multiple lines in one feed', () => {
    parser.feed(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}\n{"type":"assistant","message":{"content":[{"type":"text","text":"two"}]}}\n'
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'chunk', content: 'one' });
    expect(messages[1]).toEqual({ type: 'chunk', content: 'two' });
  });

  it('maps assistant events to chunk', () => {
    parser.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"test content"}]}}\n');
    expect(messages[0]).toEqual({ type: 'chunk', content: 'test content' });
  });

  it('maps assistant usage to session metrics', () => {
    parser.feed(
      '{"type":"stream_event","event":{"type":"message_start"}}\n' +
        '{"type":"assistant","message":{"id":"msg_step_1","content":[{"type":"text","text":"test content"}],"usage":{"input_tokens":123,"output_tokens":45,"cache_creation_input_tokens":12,"cache_read_input_tokens":7}}}\n'
    );

    expect(messages).toEqual([
      { type: 'status', status: 'working' },
      { type: 'chunk', content: 'test content' },
      {
        type: 'usage',
        scope: 'step',
        messageId: 'msg_step_1',
        metrics: expect.objectContaining({
          iterations: 1,
          totalToolCalls: 0,
          inputTokens: 123,
          outputTokens: 45,
          cacheCreationInputTokens: 12,
          cacheReadInputTokens: 7,
        }),
      },
    ]);
  });

  it('maps assistant tool_use blocks', () => {
    parser.feed(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}\n'
    );
    expect(messages[0]).toEqual({ type: 'tool_use', tool: 'Bash', args: { command: 'ls' } });
  });

  it('ignores assistant messages that only contain thinking blocks', () => {
    parser.feed(
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Let me inspect the file."}]}}\n'
    );
    expect(messages).toEqual([
      {
        type: 'phase',
        phase: 'thinking',
        label: 'Thinking through next step',
      },
    ]);
  });

  it('maps tool_use events', () => {
    parser.feed('{"type":"tool_use","tool":{"name":"Bash","args":{"command":"ls"}}}\n');
    expect(messages[0]).toEqual({ type: 'tool_use', tool: 'Bash', args: { command: 'ls' } });
  });

  it('maps tool_result events', () => {
    parser.feed('{"type":"tool_result","tool":"Bash","result":"file1\\nfile2","success":true}\n');
    expect(messages).toEqual([
      {
        type: 'phase',
        phase: 'reviewing_tool',
        label: 'Reviewing Bash output',
        tool: 'Bash',
      },
      { type: 'tool_result', tool: 'Bash', result: 'file1\nfile2', success: true },
    ]);
  });

  it('maps tool_result with success defaulting to true', () => {
    parser.feed('{"type":"tool_result","tool":"Read","result":"contents"}\n');
    expect(messages).toEqual([
      {
        type: 'phase',
        phase: 'reviewing_tool',
        label: 'Reviewing Read output',
        tool: 'Read',
      },
      { type: 'tool_result', tool: 'Read', result: 'contents', success: true },
    ]);
  });

  it('sends raw chunk for unparseable lines', () => {
    parser.feed('this is not json\n');
    expect(messages[0]).toEqual({ type: 'chunk', content: 'this is not json' });
  });

  it('sends raw chunk for unknown event types', () => {
    parser.feed('{"type":"unknown_event","data":"test"}\n');
    expect(messages[0]).toEqual({ type: 'chunk', content: '{"type":"unknown_event","data":"test"}' });
  });

  it('ignores system init events', () => {
    parser.feed('{"type":"system","subtype":"init","cwd":"/workspace"}\n');
    expect(messages).toHaveLength(0);
  });

  it('maps stream_event message boundaries to status changes', () => {
    parser.feed(
      '{"type":"stream_event","event":{"type":"message_start"}}\n{"type":"stream_event","event":{"type":"message_stop"}}\n'
    );
    expect(messages).toEqual([
      { type: 'status', status: 'working' },
      { type: 'status', status: 'ready' },
    ]);
  });

  it('maps stream_event tool phases', () => {
    parser.feed(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Read","input":{}}}}\n' +
        '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"app.js\\"}"}}}\n' +
        '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}\n'
    );
    expect(messages).toEqual([
      {
        type: 'phase',
        phase: 'preparing_tool',
        label: 'Preparing Read',
        tool: 'Read',
      },
      {
        type: 'phase',
        phase: 'preparing_tool',
        label: 'Preparing Read arguments',
        tool: 'Read',
      },
      {
        type: 'phase',
        phase: 'running_tool',
        label: 'Running Read',
        tool: 'Read',
      },
    ]);
  });

  it('maps stream_event text deltas to drafting', () => {
    parser.feed(
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}\n' +
        '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}\n'
    );
    expect(messages).toEqual([
      { type: 'phase', phase: 'drafting', label: 'Drafting response' },
      { type: 'phase', phase: 'drafting', label: 'Drafting response' },
    ]);
  });

  it('maps successful result envelopes to ready', () => {
    parser.feed(
      '{"type":"stream_event","event":{"type":"message_start"}}\n' +
        '{"type":"result","subtype":"success","result":"done","total_cost_usd":0.0025,"usage":{"input_tokens":200,"output_tokens":50,"cache_creation_input_tokens":40,"cache_read_input_tokens":10}}\n'
    );
    expect(messages).toEqual([
      { type: 'status', status: 'working' },
      {
        type: 'usage',
        scope: 'session',
        metrics: expect.objectContaining({
          iterations: 1,
          totalToolCalls: 0,
          inputTokens: 200,
          outputTokens: 50,
          cacheCreationInputTokens: 40,
          cacheReadInputTokens: 10,
          totalCostUsd: 0.0025,
        }),
      },
      { type: 'status', status: 'ready' },
    ]);
  });

  it('maps result errors to a chunk', () => {
    parser.feed('{"type":"result","subtype":"error_during_execution","errors":["Tool failed"]}\n');
    expect(messages[0]).toEqual({ type: 'chunk', content: 'Tool failed' });
  });

  it('skips empty lines', () => {
    parser.feed('\n\n{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'chunk', content: 'hi' });
  });
});
