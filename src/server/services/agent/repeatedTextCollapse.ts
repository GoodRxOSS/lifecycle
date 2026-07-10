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

const MIN_COLLAPSIBLE_LENGTH = 200;

function isPeriodic(text: string): boolean {
  return (text + text).indexOf(text, 1) < text.length;
}

/**
 * Gemini 2.5 intermittently streams its entire answer twice in one turn, producing a
 * seamless X+X text part. Collapse only that exact signature; a periodic half is
 * legitimate content (e.g. an answer that was asked to repeat itself).
 */
export function collapseExactSelfRepeat(text: string): string {
  if (text.length < MIN_COLLAPSIBLE_LENGTH || text.length % 2 !== 0) {
    return text;
  }

  const half = text.slice(0, text.length / 2);
  if (text.slice(text.length / 2) !== half || isPeriodic(half)) {
    return text;
  }

  return half;
}
