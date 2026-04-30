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

export function transformProviderModels(providers: any[]): Array<{
  provider: string;
  modelId: string;
  displayName: string;
  default: boolean;
  maxTokens: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}> {
  return providers
    .filter((provider: any) => provider.enabled)
    .flatMap((provider: any) => {
      if (!provider.models || !Array.isArray(provider.models)) {
        return [];
      }

      return provider.models
        .filter((model: any) => model.enabled)
        .map((model: any) => ({
          provider: provider.name,
          modelId: model.id,
          displayName: model.displayName,
          default: model.default || false,
          maxTokens: model.maxTokens,
          ...(model.inputCostPerMillion != null ? { inputCostPerMillion: model.inputCostPerMillion } : {}),
          ...(model.outputCostPerMillion != null ? { outputCostPerMillion: model.outputCostPerMillion } : {}),
        }));
    });
}
