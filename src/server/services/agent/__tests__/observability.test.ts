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
  applyConfiguredModelCostEstimate,
  buildMessageObservabilityMetadataPatch,
  estimateConfiguredModelCostUsd,
  normalizeSdkUsageSummary,
  sumSdkUsageSummaries,
  toUsageSummaryBaseline,
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

  it('normalizes fallback token details and supported response timestamp forms', () => {
    const date = new Date('2026-05-01T10:30:00.000Z');
    const dateSummary = normalizeSdkUsageSummary({
      usage: {
        cachedInputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 25 },
        outputTokenDetails: { reasoningTokens: 7, textTokens: 11 },
      },
      response: {
        id: ' ',
        modelId: 'model-from-sdk',
        timestamp: date,
      },
    });

    expect(dateSummary).toMatchObject({
      reasoningTokens: 7,
      cachedInputTokens: 0,
      cacheReadInputTokens: 25,
      textOutputTokens: 11,
      responseModelId: 'model-from-sdk',
      responseTimestamp: '2026-05-01T10:30:00.000Z',
    });
    expect(dateSummary.responseId).toBeUndefined();

    expect(normalizeSdkUsageSummary({ response: { timestamp: 0 } }).responseTimestamp).toBe('1970-01-01T00:00:00.000Z');
    expect(normalizeSdkUsageSummary({ response: { timestamp: 'provider-clock-value' } }).responseTimestamp).toBe(
      'provider-clock-value'
    );
    expect(normalizeSdkUsageSummary({ response: { timestamp: Number.MAX_VALUE } }).responseTimestamp).toBeUndefined();
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

  it('prefers raw usage cost and supports direct, gateway fallback, and nested USD cost formats', () => {
    const rawCost = normalizeSdkUsageSummary({
      usage: { raw: { market_cost: '0.021' } },
      providerMetadata: { totalCostUsd: 99 },
    });
    expect(rawCost).toMatchObject({ totalCostUsd: 0.021, costSource: 'usage.raw.market_cost' });

    const gatewayFallback = normalizeSdkUsageSummary({
      providerMetadata: { gateway: { cost: 'not-a-number', marketCost: '0.031' } },
    });
    expect(gatewayFallback).toMatchObject({
      totalCostUsd: 0.031,
      costSource: 'providerMetadata.gateway.marketCost',
    });

    const nestedStructured = normalizeSdkUsageSummary({
      providerMetadata: {
        billingEnvelope: {
          pricing: { usd: '0.041' },
        },
      },
    });
    expect(nestedStructured).toMatchObject({
      totalCostUsd: 0.041,
      costSource: 'providerMetadata.billingEnvelope.pricing',
    });
  });

  it('ignores non-USD structured amounts and non-object billing metadata', () => {
    const summary = normalizeSdkUsageSummary({
      providerMetadata: {
        price: { amount: 12, currency: 'EUR' },
        billingNote: 'included in subscription',
      },
    });

    expect(summary.totalCostUsd).toBeUndefined();
    expect(summary.costSource).toBeUndefined();
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
      steps: [{ toolCalls: [{}, {}] }, {}, { toolCalls: [{}] }],
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
      steps: 3,
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

  it('sums additive counters while retaining the latest available response state', () => {
    const left = {
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 1,
      totalCostUsd: 0.1,
      estimatedCostUsd: 0.2,
      warningCount: 1,
      steps: 2,
      toolCalls: 3,
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
      responseId: 'response-left',
      responseModelId: 'model-left',
      responseTimestamp: '2026-05-01T00:00:00.000Z',
      costSource: 'usage.raw.cost',
      estimatedCostSource: 'configured_model_pricing',
      providerMetadata: { generation: 1 },
      rawUsage: { generation: 1 },
    };
    const right = {
      inputTokens: 5,
      totalTokens: 7,
      totalCostUsd: 0.3,
      warningCount: 2,
      steps: 0,
      toolCalls: 1,
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
      responseModelId: 'model-right',
      responseTimestamp: '2026-05-02T00:00:00.000Z',
      estimatedCostSource: 'latest-estimate-source',
      providerMetadata: { generation: 2 },
    };

    expect(sumSdkUsageSummaries(left, right)).toEqual({
      inputTokens: 15,
      outputTokens: 2,
      totalTokens: 7,
      reasoningTokens: 1,
      cachedInputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      nonCachedInputTokens: undefined,
      textOutputTokens: undefined,
      totalCostUsd: 0.4,
      estimatedCostUsd: 0.2,
      warningCount: 3,
      steps: 0,
      toolCalls: 4,
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
      responseId: 'response-left',
      responseModelId: 'model-right',
      responseTimestamp: '2026-05-02T00:00:00.000Z',
      costSource: 'usage.raw.cost',
      estimatedCostSource: 'latest-estimate-source',
      providerMetadata: { generation: 2 },
      rawUsage: { generation: 1 },
    });
  });

  it('accumulates generation observability and keeps earlier response fields when later generations omit them', () => {
    const tracker = new AgentRunObservabilityTracker();

    tracker.addGeneration({
      usage: { inputTokens: 10, outputTokens: 2, raw: { totalCostUsd: 0.01 } },
      providerMetadata: { generation: 1 },
      finishReason: 'length',
      warnings: [{ code: 'first-warning' }],
      response: { id: 'response-1', modelId: 'model-1' },
    });
    const summary = tracker.addGeneration({
      usage: { inputTokens: 4, outputTokens: 1, raw: { totalCostUsd: 0.02 } },
      providerMetadata: { generation: 2 },
      finishReason: 'stop',
      warnings: [{ code: 'second-warning' }, { code: 'third-warning' }],
      response: { modelId: 'model-2' },
    });

    expect(summary).toMatchObject({
      inputTokens: 14,
      outputTokens: 3,
      totalCostUsd: 0.03,
      warningCount: 3,
      finishReason: 'stop',
      responseId: 'response-1',
      responseModelId: 'model-2',
      providerMetadata: { generation: 2 },
    });
  });

  it('retains live step and tool-call state when final SDK steps are unavailable', () => {
    const tracker = new AgentRunObservabilityTracker();
    tracker.updateFromStep({
      usage: { inputTokens: 5, outputTokens: 1 },
      stepNumber: 3,
      toolCalls: [{}, {}],
    });
    tracker.updateFromStep({
      usage: { inputTokens: 2, outputTokens: 1 },
      stepNumber: 4,
      toolCalls: [{}],
    });

    expect(
      tracker.finalize({
        usage: { inputTokens: 9, outputTokens: 3 },
        steps: null,
      })
    ).toMatchObject({ inputTokens: 9, outputTokens: 3, steps: 4, toolCalls: 3 });
  });

  it('keeps an empty optional step update neutral', () => {
    const tracker = new AgentRunObservabilityTracker();

    const summary = tracker.updateFromStep({});

    expect(summary.inputTokens).toBeUndefined();
    expect(summary.steps).toBeUndefined();
    expect(summary.toolCalls).toBeUndefined();
  });

  it('accumulates a resumed execution on top of the persisted baseline so totals never drop (L9)', () => {
    const tracker = new AgentRunObservabilityTracker(
      { inputCostPerMillion: 1, outputCostPerMillion: 2 },
      {
        inputTokens: 400_000,
        outputTokens: 9_000,
        totalTokens: 409_000,
        totalCostUsd: 0.5,
        toolCalls: 4,
        finishReason: 'stop',
        responseId: 'resp_segment_1',
      }
    );

    expect(tracker.getSummary()).toMatchObject({
      inputTokens: 400_000,
      totalTokens: 409_000,
    });

    tracker.updateFromStep({
      usage: { inputTokens: 100_000, outputTokens: 1_000, totalTokens: 101_000 },
      stepNumber: 1,
      toolCalls: [{}],
    });
    expect(tracker.getSummary()).toMatchObject({
      inputTokens: 500_000,
      totalTokens: 510_000,
      toolCalls: 5,
    });

    const settled = tracker.finalize({
      usage: { inputTokens: 100_000, outputTokens: 2_000, totalTokens: 102_000 },
      finishReason: 'stop',
    });
    expect(settled).toMatchObject({
      inputTokens: 500_000,
      outputTokens: 11_000,
      totalTokens: 511_000,
      totalCostUsd: 0.5,
      finishReason: 'stop',
    });
    expect(settled.estimatedCostUsd).toBeCloseTo(0.522);
    expect(settled.responseId).toBeUndefined();

    // Loop budgets are per execution: classification sees only segment 2's usage.
    expect(tracker.getSegmentSummary()).toMatchObject({ inputTokens: 100_000 });
  });

  it('extracts only additive numeric fields into a usage baseline', () => {
    expect(toUsageSummaryBaseline({ finishReason: 'stop', responseId: 'x', steps: 3 })).toBeNull();
    expect(toUsageSummaryBaseline({})).toBeNull();
    expect(toUsageSummaryBaseline(null)).toBeNull();
    expect(toUsageSummaryBaseline({ inputTokens: 10, estimatedCostUsd: 1, costSource: 'y' })).toEqual({
      inputTokens: 10,
    });

    expect(
      toUsageSummaryBaseline({
        inputTokens: '10',
        outputTokens: 2,
        totalTokens: 12,
        reasoningTokens: 1,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 5,
        nonCachedInputTokens: 6,
        textOutputTokens: 7,
        totalCostUsd: '0.25',
        toolCalls: 8,
        estimatedCostUsd: 100,
        providerMetadata: { secret: 'not carried into a resume baseline' },
      })
    ).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      reasoningTokens: 1,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 5,
      nonCachedInputTokens: 6,
      textOutputTokens: 7,
      totalCostUsd: 0.25,
      toolCalls: 8,
    });
  });

  it('declines configured estimates when usage or required non-negative rates are unavailable', () => {
    expect(estimateConfiguredModelCostUsd({}, { inputCostPerMillion: 1, outputCostPerMillion: 1 })).toEqual({});
    expect(estimateConfiguredModelCostUsd({ inputTokens: 10 }, null)).toEqual({});
    expect(estimateConfiguredModelCostUsd({ inputTokens: 10 }, { inputCostPerMillion: -1 })).toEqual({});
    expect(
      estimateConfiguredModelCostUsd({ inputTokens: Number.MAX_VALUE }, { inputCostPerMillion: Number.MAX_VALUE })
    ).toEqual({});

    const summary = { inputTokens: 10, totalCostUsd: 0.5 };
    expect(applyConfiguredModelCostEstimate(summary, undefined)).toBe(summary);
  });

  it('adds configured estimates without replacing provider-reported cost', () => {
    expect(
      applyConfiguredModelCostEstimate(
        { outputTokens: 250_000, totalCostUsd: 0.75, costSource: 'providerMetadata.totalCostUsd' },
        { outputCostPerMillion: 4 }
      )
    ).toEqual({
      outputTokens: 250_000,
      totalCostUsd: 0.75,
      costSource: 'providerMetadata.totalCostUsd',
      estimatedCostUsd: 1,
      estimatedCostSource: 'configured_model_pricing',
    });
  });

  it('estimates cost from configured model pricing', () => {
    const tracker = new AgentRunObservabilityTracker({
      inputCostPerMillion: 2,
      outputCostPerMillion: 10,
    });

    const liveSummary = tracker.updateFromStep({
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
      },
      stepNumber: 1,
    });

    expect(liveSummary).toMatchObject({
      estimatedCostUsd: 3,
      estimatedCostSource: 'configured_model_pricing',
    });

    const finalSummary = tracker.finalize({
      usage: {
        inputTokens: 500_000,
        outputTokens: 50_000,
        totalTokens: 550_000,
      },
    });

    expect(finalSummary).toMatchObject({
      inputTokens: 500_000,
      outputTokens: 50_000,
      totalTokens: 550_000,
      estimatedCostUsd: 1.5,
      estimatedCostSource: 'configured_model_pricing',
    });
  });

  it('projects complete observability state into assistant message metadata', () => {
    const summary = {
      inputTokens: 10,
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
      responseId: 'response-123',
      responseModelId: 'model-123',
      responseTimestamp: '2026-05-01T10:30:00.000Z',
      warningCount: 0,
      providerMetadata: { gateway: { requestId: 'gateway-123' } },
    };

    expect(buildMessageObservabilityMetadataPatch(summary)).toEqual({
      usage: summary,
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
      responseId: 'response-123',
      responseModelId: 'model-123',
      model: 'model-123',
      responseTimestamp: '2026-05-01T10:30:00.000Z',
      warningCount: 0,
      providerMetadata: { gateway: { requestId: 'gateway-123' } },
    });
  });

  it('returns an empty message metadata patch for an empty summary', () => {
    expect(buildMessageObservabilityMetadataPatch({})).toEqual({});
  });
});
