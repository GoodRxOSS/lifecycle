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

import { repairAgentToolName } from '../toolCallRepair';

const KEYS = [
  'mcp__workspace_core__exec',
  'mcp__workspace_core__start_service',
  'mcp__workspace_core__list_files',
  'mcp__lifecycle__request_workspace',
];

describe('repairAgentToolName', () => {
  it('strips a provider-invented namespace prefix (the observed Gemini failure)', () => {
    expect(repairAgentToolName('default_api:mcp__workspace_core__exec', KEYS)).toBe('mcp__workspace_core__exec');
    expect(repairAgentToolName('functions.mcp__workspace_core__list_files', KEYS)).toBe(
      'mcp__workspace_core__list_files'
    );
  });

  it('strips stacked prefixes', () => {
    expect(repairAgentToolName('default_api:tool:mcp__workspace_core__exec', KEYS)).toBe('mcp__workspace_core__exec');
  });

  it('resolves a bare tool name to its unique registered key', () => {
    expect(repairAgentToolName('exec', KEYS)).toBe('mcp__workspace_core__exec');
    expect(repairAgentToolName('default_api:start_service', KEYS)).toBe('mcp__workspace_core__start_service');
  });

  it('does NOT reactivate a correctly-named tool that is inactive for this step', () => {
    // Exact registered key raising NoSuchToolError means it is intentionally gated off (e.g. the
    // budget-forced final-answer step) — repairing it would defeat that gate.
    expect(repairAgentToolName('mcp__workspace_core__exec', KEYS)).toBeNull();
  });

  it('returns null when a bare name is ambiguous across servers', () => {
    const ambiguous = ['mcp__a__status', 'mcp__b__status'];
    expect(repairAgentToolName('status', ambiguous)).toBeNull();
  });

  it('returns null when nothing plausibly matches', () => {
    expect(repairAgentToolName('totally_unknown_tool', KEYS)).toBeNull();
    expect(repairAgentToolName('mcp__workspace_core__nonexistent', KEYS)).toBeNull();
  });

  it('accepts a Set of keys', () => {
    expect(repairAgentToolName('default_api:mcp__workspace_core__exec', new Set(KEYS))).toBe(
      'mcp__workspace_core__exec'
    );
  });
});
