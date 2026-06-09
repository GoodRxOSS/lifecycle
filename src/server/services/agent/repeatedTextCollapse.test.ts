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

import { collapseExactSelfRepeat } from './repeatedTextCollapse';

const SENTENCE =
  'Mountains, towering sentinels of our planet, evoke a sense of awe and wonder unlike any other formation. ';
const ESSAY = SENTENCE.repeat(4) + 'They are colossal testaments to dynamic geological processes over millennia.';

describe('collapseExactSelfRepeat', () => {
  it('collapses a seamless doubled answer to a single copy', () => {
    expect(collapseExactSelfRepeat(ESSAY + ESSAY)).toBe(ESSAY);
  });

  it('keeps text under the length threshold', () => {
    const short = 'hello world. ';
    expect(collapseExactSelfRepeat(short + short)).toBe(short + short);
  });

  it('keeps doubled copies joined by a separator', () => {
    const doubledWithSeparator = `${ESSAY}\n\n${ESSAY}`;
    expect(collapseExactSelfRepeat(doubledWithSeparator)).toBe(doubledWithSeparator);
  });

  it('keeps periodic content that a user asked to repeat', () => {
    // Halves are identical AND periodic; the periodicity guard must keep it.
    const chant = 'hello '.repeat(100);
    expect(collapseExactSelfRepeat(chant)).toBe(chant);
  });

  it('keeps odd-length text', () => {
    const text = `${ESSAY + ESSAY}!`;
    expect(collapseExactSelfRepeat(text)).toBe(text);
  });

  it('keeps near-duplicates that differ anywhere', () => {
    const almost = ESSAY + ESSAY.replace('millennia', 'millenia.');
    expect(collapseExactSelfRepeat(almost)).toBe(almost);
  });
});
