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

import { createHash } from 'crypto';
import {
  ErrorCode,
  ListToolsResultSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { getLogger } from 'server/lib/logger';
import Metrics from 'server/lib/metrics';
import type { Principal } from 'server/lib/principal';
import { recordAuthAuditEvent } from 'server/services/authAudit';
import type {
  McpJsonObject,
  McpAdminCapability,
  McpRuntimePolicy,
  McpToolAuditContext,
  McpToolAuditFields,
  McpToolContext,
  McpToolDefinition,
  McpToolInvocationContext,
} from './contracts';
import { McpExecutionError } from './errors';
import { executionErrorResult, successResult } from './responses';
import { compileMcpToolDefinition, type CompiledMcpToolDefinition, validationIssues } from './schemaValidator';

const MAX_DESCRIPTOR_BYTES = 2 * 1024;
const MAX_INPUT_SCHEMA_BYTES = 4 * 1024;
const MAX_OUTPUT_SCHEMA_BYTES = 8 * 1024;
const MAX_CATALOG_BYTES = 64 * 1024;

const CAPABILITIES: ReadonlyArray<Pick<McpAdminCapability, 'id' | 'label' | 'description'>> = [
  {
    id: 'understand-environments',
    label: 'Understand Environments',
    description: 'Discover repositories, validate configuration, and inspect preview environments.',
  },
  {
    id: 'diagnose-environments',
    label: 'Diagnose Environments',
    description: 'Inspect bounded, redacted diagnostic evidence for authorized environments.',
  },
  {
    id: 'manage-environments',
    label: 'Manage Environments',
    description: 'Create, configure, deploy, extend, and destroy preview environments.',
  },
  {
    id: 'view-hosted-sites',
    label: 'View Hosted Sites',
    description: 'List and inspect hosted sites visible to the signed-in Lifecycle user.',
  },
];

export interface McpMetricSink {
  increment(metric: string, tags?: Record<string, string>): unknown;
  timing(metric: string, milliseconds: number, tags?: Record<string, string>): unknown;
  gauge(metric: string, value: number, tags?: Record<string, string>): unknown;
}

export interface McpToolCallAuditRecord {
  principal: Principal;
  requestId: string;
  tool: string;
  outcome: string;
  stage: 'validation' | 'policy' | 'domain' | 'success';
  fields: McpToolAuditFields;
}

export interface McpToolCallAuditSink {
  record(record: McpToolCallAuditRecord): void | Promise<void>;
}

const defaultMetrics = new Metrics('mcp', {});
const defaultAudit: McpToolCallAuditSink = {
  record: async ({ principal, requestId, tool, outcome, stage, fields }) => {
    await recordAuthAuditEvent({
      event: 'mcp.tool_call',
      principalKind: principal.kind,
      principalId: principal.userId,
      actorId: principal.actor,
      tokenId: principal.tokenId,
      requestId,
      route: `MCP ${tool}`.slice(0, 255),
      outcome,
      meta: {
        tool,
        stage,
        credentialKind: principal.kind,
        ...fields,
      },
    });
  },
};

function assertDefinitionBounds(definition: McpToolDefinition): void {
  for (const [field, value] of [
    ['title', definition.title],
    ['description', definition.description],
  ] as const) {
    if (Buffer.byteLength(value, 'utf8') > MAX_DESCRIPTOR_BYTES) {
      throw new Error(`${definition.name}.${field} exceeds ${MAX_DESCRIPTOR_BYTES} UTF-8 bytes`);
    }
  }
  for (const [field, value, maxBytes] of [
    ['inputSchema', definition.inputSchema, MAX_INPUT_SCHEMA_BYTES],
    ['outputSchema', definition.outputSchema, MAX_OUTPUT_SCHEMA_BYTES],
  ] as const) {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
      throw new Error(`${definition.name}.${field} exceeds ${maxBytes} UTF-8 bytes`);
    }
  }
}

function boundedToolName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 128);
}

function safeIdentifier(value: unknown, pattern: RegExp, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength && pattern.test(value) ? value : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function initialAuditFields(input: McpJsonObject): McpToolAuditFields {
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined;
  const confirmation =
    input.confirmation && typeof input.confirmation === 'object' && !Array.isArray(input.confirmation)
      ? (input.confirmation as McpJsonObject)
      : undefined;
  const operation =
    confirmation?.phase === 'preview' || confirmation?.phase === 'execute' ? confirmation.phase : undefined;

  return {
    ...(safeIdentifier(input.uuid, /^[A-Za-z0-9_-]+$/, 100) ? { uuid: input.uuid as string } : {}),
    ...(positiveSafeInteger(input.environmentId) ? { environmentId: Number(input.environmentId) } : {}),
    ...(safeIdentifier(input.siteId, /^[A-Za-z0-9_-]{10,24}$/, 24) ? { siteId: input.siteId as string } : {}),
    ...(idempotencyKey
      ? {
          idempotencyKeyFingerprint: createHash('sha256')
            .update(`mcp-idempotency-key\0${idempotencyKey}`, 'utf8')
            .digest('hex'),
        }
      : {}),
    ...(operation ? { operation } : {}),
  };
}

function inputValidationError(errors: NonNullable<Parameters<typeof validationIssues>[0]>): McpExecutionError {
  return new McpExecutionError('invalid_body', 'Check the tool arguments and try again.', {
    details: validationIssues(errors),
  });
}

function normalizeAuditFields(fields: Partial<McpToolAuditFields>): Partial<McpToolAuditFields> {
  return {
    ...(safeIdentifier(fields.uuid, /^[A-Za-z0-9_-]+$/, 100) ? { uuid: fields.uuid } : {}),
    ...(positiveSafeInteger(fields.environmentId) ? { environmentId: Number(fields.environmentId) } : {}),
    ...(safeIdentifier(fields.deployId, /^[A-Za-z0-9_-]+$/, 100) ? { deployId: fields.deployId } : {}),
    ...(safeIdentifier(fields.siteId, /^[A-Za-z0-9_-]{10,24}$/, 24) ? { siteId: fields.siteId } : {}),
    ...(safeIdentifier(fields.idempotencyKeyFingerprint, /^[0-9a-f]{64}$/, 64)
      ? { idempotencyKeyFingerprint: fields.idempotencyKeyFingerprint }
      : {}),
    ...(fields.operation === 'preview' || fields.operation === 'execute' ? { operation: fields.operation } : {}),
  };
}

function toolAvailable(definition: McpToolDefinition, policy: McpRuntimePolicy): boolean {
  if (!policy.enabled) return false;
  if (definition.access === 'change' && !policy.allowChanges) return false;
  if (definition.capabilityId === 'view-hosted-sites' && !policy.sitesAvailable) return false;
  return true;
}

export function buildMcpAdminCatalog(
  definitions: readonly McpToolDefinition[],
  options: { sitesAvailable: boolean }
): McpAdminCapability[] {
  return CAPABILITIES.filter((capability) => capability.id !== 'view-hosted-sites' || options.sitesAvailable).map(
    (capability) => ({
      ...capability,
      tools: definitions
        .filter((definition) => definition.capabilityId === capability.id)
        .map(({ name, description, access }) => ({ name, description, access })),
    })
  );
}

export class McpToolRegistry {
  private readonly ordered: CompiledMcpToolDefinition[];
  private readonly byName: Map<string, CompiledMcpToolDefinition>;
  private readonly metrics: McpMetricSink;
  private readonly audit: McpToolCallAuditSink;

  constructor(
    definitions: McpToolDefinition[],
    metrics: McpMetricSink = defaultMetrics,
    audit: McpToolCallAuditSink = defaultAudit
  ) {
    const names = new Set<string>();
    this.ordered = definitions.map((definition) => {
      if (names.has(definition.name)) {
        throw new Error(`Duplicate MCP tool definition: ${definition.name}`);
      }
      names.add(definition.name);
      assertDefinitionBounds(definition);
      return compileMcpToolDefinition(definition);
    });
    this.byName = new Map(this.ordered.map((entry) => [entry.definition.name, entry]));
    this.metrics = metrics;
    this.audit = audit;
    // Validate the exact SDK-facing shape once at construction, before serving.
    this.listTools({ enabled: true, allowChanges: true, sitesAvailable: true });
  }

  definitions(): readonly McpToolDefinition[] {
    return this.ordered.map((entry) => entry.definition);
  }

  listTools(policy: McpRuntimePolicy): { tools: Tool[] } {
    const result = {
      tools: this.ordered
        .filter(({ definition }) => toolAvailable(definition, policy))
        .map(({ definition }) => ({
          name: definition.name,
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
          outputSchema: definition.outputSchema,
          annotations: definition.annotations,
        })),
    };
    const parsed = ListToolsResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error(`MCP catalog does not satisfy the SDK ListToolsResult schema: ${parsed.error.message}`);
    }
    const catalogBytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
    if (catalogBytes > MAX_CATALOG_BYTES) {
      throw new Error(`MCP catalog exceeds ${MAX_CATALOG_BYTES} UTF-8 bytes`);
    }
    return parsed.data;
  }

  async callTool(
    name: string,
    input: McpJsonObject,
    context: McpToolInvocationContext,
    policy: McpRuntimePolicy
  ): Promise<CallToolResult> {
    const compiled = this.byName.get(name);
    if (!compiled) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${boundedToolName(name)}`);
    }
    if (!toolAvailable(compiled.definition, policy)) {
      return executionErrorResult(
        new McpExecutionError(
          'toolset_disabled',
          !policy.enabled
            ? 'Lifecycle MCP is disabled by an administrator.'
            : compiled.definition.access === 'change'
            ? 'Changes through Lifecycle MCP are disabled by an administrator.'
            : 'This Lifecycle capability is not available.'
        ),
        context.requestId
      );
    }

    const metricTags = { tool: compiled.definition.name };
    const metricStartedAt = Date.now();
    this.recordMetric(() => this.metrics.increment('tool.calls', metricTags));
    const shouldAudit = compiled.definition.annotations.readOnlyHint !== true;
    const auditFields = initialAuditFields(input);
    const auditContext: McpToolAuditContext = {
      annotate: (fields) => Object.assign(auditFields, normalizeAuditFields(fields)),
    };
    const invocationContext: McpToolContext = { ...context, audit: auditContext };
    let auditStage: McpToolCallAuditRecord['stage'] = 'validation';
    let auditOutcome = 'internal_error';

    try {
      if (!compiled.validateInput(input)) {
        throw inputValidationError(compiled.validateInput.errors!);
      }
      auditStage = 'policy';
      const principal = context.principal;
      if (
        principal.kind !== 'user' ||
        principal.authMethod !== 'oauth' ||
        (!principal.roles.includes('user') && !principal.roles.includes('admin'))
      ) {
        throw new McpExecutionError('forbidden_role', 'Lifecycle MCP requires the user or admin role.');
      }
      auditStage = 'domain';
      const output = await compiled.definition.handler(input, invocationContext);
      const result = successResult(output, context.requestId, compiled.validateOutput);
      auditStage = 'success';
      auditOutcome = 'succeeded';
      this.recordResponseMetrics(result, metricTags);
      return result;
    } catch (error) {
      if (error instanceof McpExecutionError) {
        auditOutcome = error.code;
        const result = executionErrorResult(error, context.requestId);
        this.recordMetric(() => this.metrics.increment('tool.errors', { ...metricTags, code: error.code }));
        this.recordResponseMetrics(result, metricTags);
        return result;
      }
      auditOutcome = 'internal_error';
      getLogger().error(
        { error, tool: compiled.definition.name, requestId: context.requestId },
        'MCP tool execution failed closed'
      );
      const result = executionErrorResult(
        new McpExecutionError(
          'internal_error',
          'Lifecycle could not complete this request. Ask an administrator for help.'
        ),
        context.requestId
      );
      this.recordMetric(() => this.metrics.increment('tool.errors', { ...metricTags, code: 'internal_error' }));
      this.recordResponseMetrics(result, metricTags);
      return result;
    } finally {
      this.recordMetric(() => this.metrics.timing('tool.duration_ms', Date.now() - metricStartedAt, metricTags));
      if (shouldAudit) {
        await this.recordAudit({
          principal: context.principal,
          requestId: context.requestId,
          tool: compiled.definition.name,
          outcome: auditOutcome,
          stage: auditStage,
          fields: auditFields,
        });
      }
    }
  }

  private recordResponseMetrics(result: CallToolResult, metricTags: Record<string, string>): void {
    const text = result.content
      .filter((item): item is Extract<(typeof result.content)[number], { type: 'text' }> => item.type === 'text')
      .map((item) => item.text)
      .join('');
    this.recordMetric(() => this.metrics.gauge('tool.response_bytes', Buffer.byteLength(text, 'utf8'), metricTags));
  }

  private recordMetric(record: () => unknown): void {
    try {
      record();
    } catch (error) {
      getLogger().warn({ error }, 'MCP metric emission failed');
    }
  }

  private async recordAudit(record: McpToolCallAuditRecord): Promise<void> {
    try {
      await this.audit.record(record);
    } catch (error) {
      getLogger().warn({ error, tool: record.tool }, 'MCP tool-call audit emission failed');
    }
  }
}
