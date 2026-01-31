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
      expect(prompt).not.toContain('# Security & Safety');
      expect(prompt).not.toContain('# Final Reminder');
    });

    it('includes all non-safety sections', () => {
      const prompt = assembleBasePrompt();
      expect(prompt).toContain('You are Lifecycle Agent 007');
      expect(prompt).toContain('# Communication Style');
      expect(prompt).toContain('# Investigation Pattern');
      expect(prompt).toContain('## Tool Execution Rules');
      expect(prompt).toContain('# Output Format');
      expect(prompt).toContain('# Lifecycle Architecture');
      expect(prompt).toContain('# Examples');
    });

    it('excludes sections by id when excludeIds provided', () => {
      const prompt = assembleBasePrompt(['examples']);
      expect(prompt).not.toContain('# Examples');
      expect(prompt).not.toContain('<example>');
    });

    it('still includes non-excluded sections when excluding examples', () => {
      const prompt = assembleBasePrompt(['examples']);
      expect(prompt).toContain('You are Lifecycle Agent 007');
      expect(prompt).toContain('# Communication Style');
      expect(prompt).toContain('# Investigation Pattern');
      expect(prompt).toContain('## Tool Execution Rules');
      expect(prompt).toContain('# Output Format');
      expect(prompt).toContain('# Lifecycle Architecture');
    });

    it('supports excluding multiple sections', () => {
      const prompt = assembleBasePrompt(['examples', 'domain']);
      expect(prompt).not.toContain('# Examples');
      expect(prompt).not.toContain('# Lifecycle Architecture');
      expect(prompt).toContain('You are Lifecycle Agent 007');
      expect(prompt).toContain('# Communication Style');
    });

    it('returns same result with empty excludeIds as no argument', () => {
      expect(assembleBasePrompt([])).toBe(assembleBasePrompt());
    });

    it('assembles sections in correct order', () => {
      const prompt = assembleBasePrompt();
      const markers = [
        'You are Lifecycle Agent 007',
        '# Investigation Pattern',
        '# Lifecycle Architecture',
        '# Examples',
      ];

      const positions = markers.map((m) => prompt.indexOf(m));
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1]);
      }
    });

    it('assembled prompt contains all critical sections', () => {
      const assembled = assembleBasePrompt();
      expect(assembled).toContain('Investigation Pattern');
      expect(assembled).toContain('Fix Application Workflow');
      expect(assembled).toContain('Status-First Investigation Strategy');
      expect(assembled).toContain('investigation_complete');
      expect(assembled).toContain('Verification Protocol');
      expect(assembled).toContain('Avoid Loops');
      expect(assembled).toContain('Lifecycle Architecture');
      expect(assembled).toContain('# Examples');
    });
  });

  describe('PROMPT_SECTIONS', () => {
    it('has exactly 5 entries', () => {
      expect(PROMPT_SECTIONS).toHaveLength(5);
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
        'Investigation Pattern',
        'Status-First Investigation Strategy',
        'Fix Application Workflow',
        'MAX 3 calls',
        'investigation_complete',
        'fixesApplied',
        'canAutoFix',
        'Verification Protocol',
        'Compare States',
        'Avoid Loops',
        'Identify Symptom',
        'Read Sitemap',
        'Follow References',
      ];
      for (const phrase of requiredPhrases) {
        expect(assembled).toContain(phrase);
      }
    });

    it('safety section contains required safety rules', () => {
      const safetySection = PROMPT_SECTIONS.find((s) => s.id === 'safety');
      expect(safetySection).toBeDefined();
      expect(safetySection!.content).toBe(SAFETY_SECTION);
      expect(safetySection!.content).toContain('User Consent');
      expect(safetySection!.content).toContain('Surgical Changes');
      expect(safetySection!.content).toContain('Path Verification');
      expect(safetySection!.content).toContain('Compare States');
    });
  });
});
