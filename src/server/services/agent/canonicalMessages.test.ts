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

import {
  getCanonicalPartsFromUiMessage,
  normalizeCanonicalAgentMessagePart,
  toUiMessageFromCanonicalInput,
} from './canonicalMessages';
import type { AgentUIMessage } from './types';

const SECRET = 'ghp_1234567890abcdefghij1234567890ABCDwxyz';

describe('canonical reasoning scrubbing', () => {
  it('redacts secrets in reasoning when normalizing a stored part', () => {
    const part = normalizeCanonicalAgentMessagePart({
      type: 'reasoning',
      text: `I will reuse the token ${SECRET} to call the API.`,
    });

    expect(part).toEqual({ type: 'reasoning', text: 'I will reuse the token [redacted] to call the API.' });
  });

  it('redacts secrets in reasoning extracted from a UI message (persistence path)', () => {
    const message = {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: `Using ${SECRET} next.` }],
    } as unknown as AgentUIMessage;

    const parts = getCanonicalPartsFromUiMessage(message);
    expect(parts).toEqual([{ type: 'reasoning', text: 'Using [redacted] next.' }]);
  });

  it('does NOT scrub ordinary text parts', () => {
    const part = normalizeCanonicalAgentMessagePart({
      type: 'text',
      text: `Here is the token ${SECRET} for you.`,
    });

    expect(part).toEqual({ type: 'text', text: `Here is the token ${SECRET} for you.` });
  });

  it('scrubs reasoning on the read/display path too', () => {
    const ui = toUiMessageFromCanonicalInput({
      role: 'assistant',
      parts: [{ type: 'reasoning', text: `legacy ${SECRET} value` }],
    });

    expect(ui.parts).toEqual([{ type: 'reasoning', text: 'legacy [redacted] value' }]);
  });
});

describe('self-repeated assistant text collapse (persistence path)', () => {
  const ANSWER =
    'Rivers are dynamic arteries, shaping landscapes and sustaining ecosystems since the dawn of humanity. ' +
    'From the majestic Amazon to the historic Nile, they have played an indelible role in the story of Earth. ' +
    'Their journeys begin as humble trickles, often high in mountainous regions, fed by melting snows.';

  it('collapses a seamlessly doubled assistant answer', () => {
    const message = {
      id: 'm-doubled',
      role: 'assistant',
      parts: [{ type: 'text', text: ANSWER + ANSWER }],
    } as unknown as AgentUIMessage;

    expect(getCanonicalPartsFromUiMessage(message)).toEqual([{ type: 'text', text: ANSWER }]);
  });

  it('stores doubled user text verbatim', () => {
    const message = {
      id: 'm-user',
      role: 'user',
      parts: [{ type: 'text', text: ANSWER + ANSWER }],
    } as unknown as AgentUIMessage;

    expect(getCanonicalPartsFromUiMessage(message)).toEqual([{ type: 'text', text: ANSWER + ANSWER }]);
  });
});
