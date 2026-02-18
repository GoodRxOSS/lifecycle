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

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { normalizeInvestigationPayload } from '../normalizePayload';

describe('normalizeInvestigationPayload', () => {
  it('passes through a valid payload unchanged', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'Build failed due to missing dependency',
      fixesApplied: false,
      services: [
        {
          serviceName: 'web',
          status: 'build_failed',
          issue: 'Missing dependency',
          suggestedFix: 'Add the dependency',
          fixesApplied: false,
        },
      ],
    };
    const result = normalizeInvestigationPayload(payload);
    expect(result).toEqual(payload);
  });

  it('defaults missing summary to empty string', () => {
    const payload = { type: 'investigation_complete', services: [] };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.summary).toBe('');
  });

  it('defaults missing services to empty array', () => {
    const payload = { type: 'investigation_complete', summary: 'test' };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services).toEqual([]);
  });

  it('defaults non-array services to empty array', () => {
    const payload = { type: 'investigation_complete', summary: 'test', services: 'invalid' };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services).toEqual([]);
  });

  it('defaults missing serviceName to unknown', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [{ status: 'error', issue: 'broken', suggestedFix: 'fix it' }],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].serviceName).toBe('unknown');
  });

  it('defaults missing status to error', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [{ serviceName: 'web', issue: 'broken', suggestedFix: 'fix it' }],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].status).toBe('error');
  });

  it('preserves invalid status values but logs a warning', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [{ serviceName: 'web', status: 'unknown_status', issue: 'broken', suggestedFix: 'fix' }],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].status).toBe('unknown_status');
  });

  it('defaults missing issue to empty string', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [{ serviceName: 'web', status: 'error', suggestedFix: 'fix it' }],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].issue).toBe('');
  });

  it('defaults missing suggestedFix to empty string', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [{ serviceName: 'web', status: 'error', issue: 'broken' }],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].suggestedFix).toBe('');
  });

  it('forces canAutoFix=false when missing or non-boolean', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        { serviceName: 'web', status: 'error', issue: 'broken', suggestedFix: 'fix it' },
        { serviceName: 'api', status: 'error', issue: 'broken', suggestedFix: 'fix it', canAutoFix: 'yes' },
      ],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].canAutoFix).toBe(false);
    expect(result.services[1].canAutoFix).toBe(false);
  });

  it('downgrades canAutoFix when specific error evidence is missing', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        {
          serviceName: 'web',
          status: 'deploy_failed',
          issue: 'Schema grant failed',
          suggestedFix: "Change objs from 'a' to 'b' in lifecycle.yaml",
          canAutoFix: true,
          filePath: 'lifecycle.yaml',
          lineNumber: 42,
        },
      ],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].canAutoFix).toBe(false);
  });

  it('downgrades canAutoFix when file target is missing', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        {
          serviceName: 'web',
          status: 'deploy_failed',
          issue: 'Schema grant failed',
          keyError: 'ERROR: relation "subscriber" does not exist',
          errorSource: 'build_logs',
          suggestedFix: 'Run migrations first',
          canAutoFix: true,
        },
      ],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].canAutoFix).toBe(false);
  });

  it('downgrades canAutoFix for uncertain recommendations', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        {
          serviceName: 'web',
          status: 'deploy_failed',
          issue: 'This might be related to schema order',
          keyError: 'ERROR: relation "subscriber" does not exist',
          errorSource: 'build_logs',
          suggestedFix: "Change objs from 'a' to 'b' in lifecycle.yaml",
          canAutoFix: true,
          filePath: 'lifecycle.yaml',
        },
      ],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].canAutoFix).toBe(false);
  });

  it('keeps canAutoFix=true for actionable single-line fixes with evidence', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        {
          serviceName: 'web',
          status: 'deploy_failed',
          issue: 'Grant targets wrong table',
          keyError: 'ERROR: relation "subscriber" does not exist',
          errorSource: 'build_logs',
          suggestedFix: "Change objs from 'spatial_ref_sys' to 'subscriber,promo,stripe_customer' in lifecycle.yaml",
          canAutoFix: true,
          filePath: 'lifecycle.yaml',
          lineNumber: 105,
        },
      ],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].canAutoFix).toBe(true);
  });

  it('keeps canAutoFix=true for actionable multi-line file diffs with evidence', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        {
          serviceName: 'web',
          status: 'deploy_failed',
          issue: 'Migrations must run before grants',
          keyError: 'ERROR: relation "subscriber" does not exist',
          errorSource: 'build_logs',
          suggestedFix: 'Move migrations block before grants in lifecycle.yaml',
          canAutoFix: true,
          files: [
            {
              path: 'sysops/ansible/playbooks/lifecycle.yaml',
              oldContent: '- name: Add grants',
              newContent: '- name: Run Migrations',
            },
          ],
        },
      ],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].canAutoFix).toBe(true);
  });

  it('defaults non-boolean fixesApplied to false on services', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [{ serviceName: 'web', status: 'error', issue: 'broken', suggestedFix: 'fix', fixesApplied: 'yes' }],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.services[0].fixesApplied).toBe(false);
  });

  it('defaults non-boolean top-level fixesApplied to false', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.fixesApplied).toBe(false);
  });

  it('preserves true fixesApplied when valid', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'Fixed it',
      fixesApplied: true,
      services: [
        {
          serviceName: 'web',
          status: 'ready',
          issue: 'Was broken',
          suggestedFix: 'Fixed',
          fixesApplied: true,
        },
      ],
    };
    const result = normalizeInvestigationPayload(payload) as any;
    expect(result.fixesApplied).toBe(true);
    expect(result.services[0].fixesApplied).toBe(true);
  });

  it('downgrades canAutoFix for file edits when no file-write tool is available', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        {
          serviceName: 'web',
          status: 'deploy_failed',
          issue: 'Grant targets wrong table',
          keyError: 'ERROR: relation "subscriber" does not exist',
          errorSource: 'build_logs',
          suggestedFix: "Change objs from 'a' to 'b' in lifecycle.yaml",
          canAutoFix: true,
          filePath: 'lifecycle.yaml',
        },
      ],
    };

    const result = normalizeInvestigationPayload(payload, {
      availableTools: [{ name: 'get_file', description: 'Read repository files' }],
    }) as any;

    expect(result.services[0].canAutoFix).toBe(false);
  });

  it('allows canAutoFix for PR label fixes when a label tool is available', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        {
          serviceName: 'environment',
          status: 'error',
          issue: 'Missing deploy label blocks environment creation',
          keyError: 'Deploy label not present',
          errorSource: 'lifecycle',
          suggestedFix: 'Add the lifecycle-deploy! label to the PR to start deployment.',
          canAutoFix: true,
        },
      ],
    };

    const result = normalizeInvestigationPayload(payload, {
      availableTools: [{ name: 'mcp__github__add_pr_label', description: 'Add a label to a pull request' }],
    }) as any;

    expect(result.services[0].canAutoFix).toBe(true);
  });

  it('downgrades PR label fixes when label mutation tool is not available', () => {
    const payload = {
      type: 'investigation_complete',
      summary: 'test',
      services: [
        {
          serviceName: 'environment',
          status: 'error',
          issue: 'Missing deploy label blocks environment creation',
          keyError: 'Deploy label not present',
          errorSource: 'lifecycle',
          suggestedFix: 'Add the lifecycle-deploy! label to the PR to start deployment.',
          canAutoFix: true,
        },
      ],
    };

    const result = normalizeInvestigationPayload(payload, {
      availableTools: [{ name: 'get_issue_comment', description: 'Read pull request comment text' }],
    }) as any;

    expect(result.services[0].canAutoFix).toBe(false);
  });
});
