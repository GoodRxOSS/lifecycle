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

import { assembleBasePrompt, PROMPT_SECTIONS } from '../sectionRegistry';
import { SAFETY_SECTION } from '../sections/safety';

describe('Prompt Section Registry', () => {
  describe('assembleBasePrompt', () => {
    it('excludes safety section', () => {
      const prompt = assembleBasePrompt();
      expect(prompt).not.toContain('Violation Examples');
      expect(prompt).not.toContain('# Final Reminder');
    });

    it('includes all non-safety sections', () => {
      const prompt = assembleBasePrompt();
      expect(prompt).toContain('developers who are blocked');
      expect(prompt).toContain('# Investigation Principles');
      expect(prompt).toContain('# Output Rules');
      expect(prompt).toContain('# Lifecycle Architecture');
      expect(prompt).toContain('# Configuration Architecture');
    });

    it('excludes sections by id when excludeIds provided', () => {
      const prompt = assembleBasePrompt(['reference']);
      expect(prompt).not.toContain('# Lifecycle Architecture');
      expect(prompt).not.toContain('# Configuration Architecture');
    });

    it('still includes non-excluded sections when excluding reference', () => {
      const prompt = assembleBasePrompt(['reference']);
      expect(prompt).toContain('developers who are blocked');
      expect(prompt).toContain('# Investigation Principles');
    });

    it('supports excluding multiple sections', () => {
      const prompt = assembleBasePrompt(['investigation', 'reference']);
      expect(prompt).not.toContain('<examples>');
      expect(prompt).not.toContain('# Lifecycle Architecture');
      expect(prompt).toContain('developers who are blocked');
    });

    it('returns same result with empty excludeIds as no argument', () => {
      expect(assembleBasePrompt([])).toBe(assembleBasePrompt());
    });

    it('assembles sections in correct order (reference before foundations before investigation)', () => {
      const prompt = assembleBasePrompt();
      const markers = ['# Configuration Architecture', 'developers who are blocked', '# Investigation Principles'];

      const positions = markers.map((m) => prompt.indexOf(m));
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1]);
      }
    });

    it('assembled prompt contains all critical sections', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('Investigation Principles');
      expect(assembled).toContain('Fix Application Workflow');
      expect(assembled).toContain('Hypothesis-Driven');
      expect(assembled).toContain('investigation_complete');
      expect(assembled).toContain('Verification Protocol');
      expect(assembled).toContain('Two-Step Verification');
      expect(assembled).toContain('Lifecycle Architecture');
      expect(assembled).toContain('<examples>');
      expect(assembled).toContain('# Multi-Turn Conversation');
    });

    it('contains XML section tags in assembled prompt', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('<domain_knowledge>');
      expect(assembled).toContain('</domain_knowledge>');
      expect(assembled).toContain('<agent_identity>');
      expect(assembled).toContain('</agent_identity>');
      expect(assembled).toContain('<investigation_rules>');
      expect(assembled).toContain('</investigation_rules>');
      expect(assembled).toContain('<output_format>');
      expect(assembled).toContain('</output_format>');
      expect(assembled).toContain('<examples>');
      expect(assembled).toContain('</examples>');
      expect(assembled).toContain('<conversation_rules>');
      expect(assembled).toContain('</conversation_rules>');
    });

    it('contains output schema and field rules separation', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('<output_schema>');
      expect(assembled).toContain('</output_schema>');
      expect(assembled).toContain('## Field Rules');
    });

    it('examples contain full JSON with example_output tags', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('<example_output>');
      expect(assembled).toContain('"type": "investigation_complete"');
      expect(assembled).toContain('"fixesApplied": false');
      expect(assembled).toContain('"fixesApplied": true');
      expect(assembled).toContain('"oldContent"');
      expect(assembled).toContain('"newContent"');
    });

    it('schema uses lowercase status values', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('build_failed');
      expect(assembled).toContain('deploy_failed');
      expect(assembled).not.toContain('"status": "BUILD_FAILED');
      expect(assembled).not.toContain('"status": "DEPLOY_FAILED');
    });
  });

  describe('PROMPT_SECTIONS', () => {
    it('has exactly 4 entries', () => {
      expect(PROMPT_SECTIONS).toHaveLength(4);
    });

    it('has unique ids', () => {
      const ids = PROMPT_SECTIONS.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('has unique order values', () => {
      const orders = PROMPT_SECTIONS.map((s) => s.order);
      expect(new Set(orders).size).toBe(orders.length);
    });

    it('positions safety section last', () => {
      const sorted = PROMPT_SECTIONS.slice().sort((a, b) => a.order - b.order);
      expect(sorted[sorted.length - 1].id).toBe('safety');
    });

    it('positions reference section first', () => {
      const sorted = PROMPT_SECTIONS.slice().sort((a, b) => a.order - b.order);
      expect(sorted[0].id).toBe('reference');
    });

    it('has non-empty content for each section', () => {
      for (const section of PROMPT_SECTIONS) {
        expect(typeof section.content).toBe('string');
        expect(section.content.length).toBeGreaterThan(0);
      }
    });

    it('has a rationale for each section', () => {
      for (const section of PROMPT_SECTIONS) {
        expect(typeof section.rationale).toBe('string');
        expect(section.rationale.length).toBeGreaterThan(0);
      }
    });
  });

  describe('content fidelity', () => {
    it('assembled prompt contains all eval-critical phrases', () => {
      const assembled = assembleBasePrompt();
      const requiredPhrases = [
        'developers who are blocked',
        'reason about what you expect',
        '# Output Rules',
        'Greeting, unclear question, need clarification',
        'Investigation Principles',
        'Hypothesis-Driven',
        'Evidence-Based Stopping',
        'Fix Application Workflow',
        'investigation_complete',
        'fixesApplied',
        'canAutoFix',
        'Verification Protocol',
        'Compare States',
        'Multi-Repo Architecture',
        'Two-Step Verification',
        'Multi-Turn Conversation',
        'Challenge Responses',
        'Confidence Levels',
        'Staleness Detection',
      ];
      for (const phrase of requiredPhrases) {
        expect(assembled).toContain(phrase);
      }
    });

    it('assembled prompt does NOT contain V1 CoT suppression', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).not.toContain('Execute tools immediately without announcing intent');
      expect(assembled).not.toContain('Analysis AFTER results, not before');
    });

    it('assembled prompt removes hard tool limit', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).not.toContain('Hard limit: 20 tool calls');
    });

    it('safety section contains required safety rules', () => {
      const safetySection = PROMPT_SECTIONS.find((s) => s.id === 'safety');
      expect(safetySection).toBeDefined();
      expect(safetySection!.content).toBe(SAFETY_SECTION);
      expect(safetySection!.content).toContain('User Consent');
      expect(safetySection!.content).toContain('Surgical Changes');
      expect(safetySection!.content).toContain('Scope Boundaries');
      expect(safetySection!.content).toContain('Path Verification');
      expect(safetySection!.content).toContain('Compare States');
      expect(safetySection!.content).toContain('Violation Examples');
    });

    it('safety section contains Content Integrity rule', () => {
      const safetySection = PROMPT_SECTIONS.find((s) => s.id === 'safety');
      expect(safetySection!.content).toContain('Content Integrity');
      expect(safetySection!.content).toContain('EXACT content returned by get_file');
    });

    it('safety section contains XML tags', () => {
      const safetySection = PROMPT_SECTIONS.find((s) => s.id === 'safety');
      expect(safetySection!.content).toContain('<safety_rules>');
      expect(safetySection!.content).toContain('</safety_rules>');
    });

    it('investigation section fix workflow contains verification step', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('does your new_content differ from the original in ONLY the intended lines');
    });

    it('investigation section contains unrelated-changes negative example', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('commented-out service configuration');
    });

    it('safety section contains No Fabrication rule', () => {
      const safetySection = PROMPT_SECTIONS.find((s) => s.id === 'safety');
      expect(safetySection!.content).toContain('No Fabrication');
    });

    it('investigation section contains Insufficient Evidence rule', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('Insufficient Evidence');
      expect(assembled).toContain('do NOT fabricate a root cause from config analysis alone');
    });

    it('investigation section contains cite-then-conclude evidence pattern', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('cite-then-conclude');
      expect(assembled).toContain('first cite the specific error message from your tool results');
    });

    it('investigation section contains external knowledge restriction', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('External Knowledge Restriction');
      expect(assembled).toContain('Do not apply general knowledge');
    });

    it('investigation section explicitly permits saying I dont know', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain("I don't have enough information to determine the root cause");
    });

    it('investigation section contains fabricated-diagnosis negative example', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('finds 0 pods running and no error messages');
    });

    it('canAutoFix rule requires actual error message', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('a specific error message from logs/K8s/build output points to the problem');
    });

    it('has compound failure example', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('cascading effect');
    });

    it('has everything-healthy example', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('All 3 services');
      expect(assembled).toContain('What specific issue are you seeing');
    });
  });
});
