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

import {
  AgentRunObservabilityTracker,
  buildMessageObservabilityMetadataPatch,
  normalizeSdkUsageSummary,
} from '../observability';

describe('agent observability helpers', () => {
  it('normalizes SDK-native usage details and cost metadata', () => {
    const summary = normalizeSdkUsageSummary({
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
        reasoningTokens: 12,
        inputTokenDetails: {
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          noCacheTokens: 95,
        },
        outputTokenDetails: {
          reasoningTokens: 12,
          textTokens: 33,
        },
        raw: {
          billing: {
            amount: 0.0125,
            currency: 'USD',
          },
        },
      },
      providerMetadata: {
        gateway: {
          requestId: 'gw_123',
        },
      },
      steps: 3,
      toolCalls: 2,
      finishReason: 'stop',
      rawFinishReason: 'stop',
      warnings: [{ code: 'truncated' }],
      response: {
        id: 'resp_123',
        modelId: 'gemini-3-flash-preview',
        timestamp: '2026-04-08T12:00:00.000Z',
      },
    });

    expect(summary).toMatchObject({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      reasoningTokens: 12,
      cachedInputTokens: 20,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 20,
      nonCachedInputTokens: 95,
      textOutputTokens: 33,
      totalCostUsd: 0.0125,
      costSource: 'usage.raw.billing',
      steps: 3,
      toolCalls: 2,
      finishReason: 'stop',
      rawFinishReason: 'stop',
      warningCount: 1,
      responseId: 'resp_123',
      responseModelId: 'gemini-3-flash-preview',
      responseTimestamp: '2026-04-08T12:00:00.000Z',
    });
    expect(summary.providerMetadata).toEqual({
      gateway: {
        requestId: 'gw_123',
      },
    });
    expect(summary.rawUsage).toEqual({
      billing: {
        amount: 0.0125,
        currency: 'USD',
      },
    });
  });

  it('does not treat provider token counters as USD cost', () => {
    const summary = normalizeSdkUsageSummary({
      usage: {
        inputTokens: 90245,
        outputTokens: 1853,
        totalTokens: 92098,
      },
      providerMetadata: {
        google: {
          usageMetadata: {
            totalTokenCount: 21072,
            promptTokenCount: 20294,
            thoughtsTokenCount: 370,
            candidatesTokenCount: 408,
            cachedContentTokenCount: 16270,
          },
        },
      },
    });

    expect(summary.totalCostUsd).toBeUndefined();
    expect(summary.costSource).toBeUndefined();
  });

  it('accepts explicit gateway cost metadata', () => {
    const summary = normalizeSdkUsageSummary({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
      providerMetadata: {
        gateway: {
          cost: '0.00421',
          marketCost: '0.00500',
        },
      },
    });

    expect(summary.totalCostUsd).toBe(0.00421);
    expect(summary.costSource).toBe('providerMetadata.gateway.cost');
  });

  it('tracks step usage live and replaces it with final aggregated usage', () => {
    const tracker = new AgentRunObservabilityTracker();

    tracker.updateFromStep({
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      stepNumber: 1,
      toolCalls: [{}, {}],
    });

    tracker.updateFromStep({
      usage: {
        inputTokens: 15,
        outputTokens: 5,
        totalTokens: 20,
      },
      stepNumber: 2,
      toolCalls: [{}],
    });

    expect(tracker.getSummary()).toMatchObject({
      inputTokens: 25,
      outputTokens: 7,
      totalTokens: 32,
      steps: 2,
      toolCalls: 3,
    });

    const finalSummary = tracker.finalize({
      usage: {
        inputTokens: 40,
        outputTokens: 8,
        totalTokens: 48,
        raw: {
          totalCostUsd: 0.01,
        },
      },
      steps: [{ toolCalls: [{}, {}] }, { toolCalls: [{}] }],
      finishReason: 'stop',
      response: {
        id: 'resp_final',
      },
    });

    expect(finalSummary).toMatchObject({
      inputTokens: 40,
      outputTokens: 8,
      totalTokens: 48,
      totalCostUsd: 0.01,
      steps: 2,
      toolCalls: 3,
      finishReason: 'stop',
      responseId: 'resp_final',
    });

    expect(buildMessageObservabilityMetadataPatch(finalSummary)).toMatchObject({
      usage: finalSummary,
      finishReason: 'stop',
      responseId: 'resp_final',
    });
  });
});
