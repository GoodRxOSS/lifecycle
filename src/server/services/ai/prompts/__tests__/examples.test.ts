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

import { EXAMPLES_SECTION } from '../sections/examples';

describe('EXAMPLES_SECTION', () => {
  it('is a non-empty string', () => {
    expect(typeof EXAMPLES_SECTION).toBe('string');
    expect(EXAMPLES_SECTION.length).toBeGreaterThan(0);
  });

  it('contains build failure investigation', () => {
    expect(EXAMPLES_SECTION).toContain('build fail');
  });

  it('contains multi-service investigation', () => {
    expect(EXAMPLES_SECTION).toContain('environment looks broken');
  });

  it('contains fix scenario', () => {
    expect(EXAMPLES_SECTION).toContain('Fix the dockerfile');
    expect(EXAMPLES_SECTION).toContain('fixesApplied');
  });

  it('contains anti-narration negative example', () => {
    expect(EXAMPLES_SECTION).toContain('negative-example');
    expect(EXAMPLES_SECTION).toContain('WRONG');
    expect(EXAMPLES_SECTION).toContain('RIGHT');
  });

  it('does not reference modeDetector or ConversationMode', () => {
    expect(EXAMPLES_SECTION).not.toContain('ConversationMode');
    expect(EXAMPLES_SECTION).not.toContain('modeDetector');
  });

  it('has exactly 4 examples (3 positive + 1 negative)', () => {
    const positiveCount = (EXAMPLES_SECTION.match(/<example>/g) || []).length;
    const negativeCount = (EXAMPLES_SECTION.match(/<negative-example>/g) || []).length;
    expect(positiveCount).toBe(3);
    expect(negativeCount).toBe(1);
  });
});
