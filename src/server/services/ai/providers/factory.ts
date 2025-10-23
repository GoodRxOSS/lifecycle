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

import { LLMProvider } from '../types/provider';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';

export type ProviderType = 'anthropic' | 'openai' | 'gemini';

export interface ProviderConfig {
  provider: ProviderType;
  modelId?: string;
  apiKey?: string;
}

export class ProviderFactory {
  static create(config: ProviderConfig): LLMProvider {
    const apiKey = config.apiKey || this.getDefaultApiKey(config.provider);

    switch (config.provider) {
      case 'anthropic':
        return new AnthropicProvider(config.modelId, apiKey);
      case 'openai':
        return new OpenAIProvider(config.modelId, apiKey);
      case 'gemini':
        return new GeminiProvider(config.modelId, apiKey);
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  private static getDefaultApiKey(provider: ProviderType): string | undefined {
    switch (provider) {
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;
      case 'openai':
        return process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
      case 'gemini':
        return process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
      default:
        return undefined;
    }
  }
}
