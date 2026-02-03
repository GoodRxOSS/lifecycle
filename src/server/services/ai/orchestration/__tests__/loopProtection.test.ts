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

import { LoopDetector } from '../loopProtection';

describe('LoopDetector', () => {
  it('uses default values', () => {
    const d = new LoopDetector();
    const p = d.getProtection();
    expect(p.maxIterations).toBe(20);
    expect(p.maxToolCalls).toBe(50);
    expect(p.maxRepeatedCalls).toBe(1);
  });

  it('accepts custom options', () => {
    const d = new LoopDetector({ maxIterations: 10, maxToolCalls: 25, maxRepeatedCalls: 5 });
    const p = d.getProtection();
    expect(p.maxIterations).toBe(10);
    expect(p.maxToolCalls).toBe(25);
    expect(p.maxRepeatedCalls).toBe(5);
  });

  it('recordCall adds to history', () => {
    const d = new LoopDetector();
    d.recordCall('get_file', { path: 'a.ts' }, 1);
    d.recordCall('get_file', { path: 'b.ts' }, 2);
    expect(d.getProtection().toolCallHistory).toHaveLength(2);
  });

  it('countRepeatedCalls returns 0 for no history', () => {
    const d = new LoopDetector();
    expect(d.countRepeatedCalls('get_file', { path: 'a.ts' }, 1)).toBe(0);
  });

  it('counts exact matches (same tool + same args)', () => {
    const d = new LoopDetector();
    d.recordCall('get_file', { path: 'a.ts' }, 1);
    d.recordCall('get_file', { path: 'a.ts' }, 2);
    d.recordCall('get_file', { path: 'a.ts' }, 3);
    expect(d.countRepeatedCalls('get_file', { path: 'a.ts' }, 3)).toBe(3);
  });

  it('ignores calls older than 5 iterations', () => {
    const d = new LoopDetector();
    d.recordCall('get_file', { path: 'a.ts' }, 1);
    expect(d.countRepeatedCalls('get_file', { path: 'a.ts' }, 7)).toBe(0);
  });

  it('includes calls within 5-iteration window', () => {
    const d = new LoopDetector();
    d.recordCall('get_file', { path: 'a.ts' }, 2);
    expect(d.countRepeatedCalls('get_file', { path: 'a.ts' }, 7)).toBe(1);
  });

  it('ignores different tool names', () => {
    const d = new LoopDetector();
    d.recordCall('get_pod_logs', { path: 'a.ts' }, 1);
    expect(d.countRepeatedCalls('get_file', { path: 'a.ts' }, 1)).toBe(0);
  });

  it('ignores different args', () => {
    const d = new LoopDetector();
    d.recordCall('get_file', { path: 'b.ts' }, 1);
    expect(d.countRepeatedCalls('get_file', { path: 'a.ts' }, 1)).toBe(0);
  });

  it('returns hint about searching resources for get_k8s_resources without name', () => {
    const d = new LoopDetector();
    const hint = d.getLoopHint('get_k8s_resources', { namespace: 'ns' });
    expect(hint).toContain('searching for resources');
  });

  it('returns default hint for get_k8s_resources with name', () => {
    const d = new LoopDetector();
    const hint = d.getLoopHint('get_k8s_resources', { name: 'pod1' });
    expect(hint).toBe('Consider trying a different tool or different arguments.');
  });

  it('returns hint about fetching logs for get_pod_logs', () => {
    const d = new LoopDetector();
    const hint = d.getLoopHint('get_pod_logs', {});
    expect(hint).toContain('fetching logs');
  });

  it('returns default hint for other tools', () => {
    const d = new LoopDetector();
    const hint = d.getLoopHint('other_tool', {});
    expect(hint).toBe('Consider trying a different tool or different arguments.');
  });

  it('reset clears toolCallHistory', () => {
    const d = new LoopDetector();
    d.recordCall('get_file', { path: 'a.ts' }, 1);
    d.reset();
    expect(d.getProtection().toolCallHistory).toHaveLength(0);
  });
});
