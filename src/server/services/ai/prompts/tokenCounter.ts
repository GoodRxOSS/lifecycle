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

import { getEncoding, Tiktoken } from 'js-tiktoken';
import { PROMPT_SECTIONS } from './sectionRegistry';

let _encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!_encoder) {
    _encoder = getEncoding('cl100k_base');
  }
  return _encoder;
}

export interface TokenBreakdown {
  sections: Record<string, number>;
  providerAugmentation: number;
  environmentContext: number;
  total: number;
}

export interface TokenBudget {
  provider: string;
  limit: number;
  used: number;
  remaining: number;
  overBudget: boolean;
}

export const PROVIDER_TOKEN_LIMITS: Record<string, number> = {
  anthropic: 180000,
  openai: 110000,
  gemini: 900000,
};

export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

export function countSectionTokens(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const section of PROMPT_SECTIONS) {
    result[section.id] = countTokens(section.content);
  }
  return result;
}

export function getTokenBreakdown(systemPrompt: string, sections?: Record<string, number>): TokenBreakdown {
  const sectionCounts = sections || countSectionTokens();
  const sectionTotal = Object.values(sectionCounts).reduce((sum, v) => sum + v, 0);
  const totalTokens = countTokens(systemPrompt);
  const overhead = Math.max(0, totalTokens - sectionTotal);

  const providerAugmentation = Math.floor(overhead / 2);
  const environmentContext = overhead - providerAugmentation;

  return {
    sections: sectionCounts,
    providerAugmentation,
    environmentContext,
    total: sectionTotal + providerAugmentation + environmentContext,
  };
}

export function checkBudget(
  systemPrompt: string,
  provider: 'anthropic' | 'openai' | 'gemini',
  tokenCount?: number
): TokenBudget {
  const used = tokenCount ?? countTokens(systemPrompt);
  const limit = PROVIDER_TOKEN_LIMITS[provider];
  return {
    provider,
    limit,
    used,
    remaining: limit - used,
    overBudget: used > limit,
  };
}
