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

// MCP config secret hygiene: collect, redact for display/logs, restore on update, and detect presence.

import type {
  McpCompiledConnectionConfig,
  McpResolvedTransportConfig,
  McpServerConfigRecord,
  McpSharedConnectionConfig,
  McpTransportConfig,
} from './types';

const REDACTED_SHARED_SECRET = '******';
const MIN_SECRET_REDACTION_LENGTH = 4;
const NON_SECRET_REDACTION_VALUES = new Set([
  'bearer',
  'basic',
  'false',
  'http',
  'https',
  'none',
  'null',
  'oauth',
  'true',
]);
const SHARED_SECRET_SECTIONS: (keyof McpSharedConnectionConfig)[] = ['headers', 'query', 'env', 'defaultArgs'];

export type McpErrorRedactionSource = {
  values?: Record<string, unknown> | null;
  compiledConfig?: Partial<McpCompiledConnectionConfig> | null;
  transport?: McpResolvedTransportConfig | McpTransportConfig | null;
  extraSecrets?: unknown[];
};

function addSecretValue(secrets: Set<string>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }

  const secret = value.trim();
  if (
    secret.length < MIN_SECRET_REDACTION_LENGTH ||
    secret === REDACTED_SHARED_SECRET ||
    NON_SECRET_REDACTION_VALUES.has(secret.toLowerCase())
  ) {
    return;
  }

  secrets.add(secret);
  secrets.add(encodeURIComponent(secret));
  const encoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
  secrets.add(encoded);
}

function collectUnknownSecretValues(value: unknown, secrets: Set<string>): void {
  if (typeof value === 'string') {
    addSecretValue(secrets, value);
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUnknownSecretValues(item, secrets);
    }
    return;
  }

  for (const item of Object.values(value)) {
    collectUnknownSecretValues(item, secrets);
  }
}

function collectRecordSecretValues(values: Record<string, unknown> | undefined | null, secrets: Set<string>): void {
  if (!values) {
    return;
  }

  for (const value of Object.values(values)) {
    addSecretValue(secrets, value);
  }
}

function collectCompiledConfigSecretValues(
  config: Partial<McpCompiledConnectionConfig> | undefined | null,
  secrets: Set<string>
): void {
  if (!config) {
    return;
  }

  collectRecordSecretValues(config.headers, secrets);
  collectRecordSecretValues(config.query, secrets);
  collectRecordSecretValues(config.env, secrets);
  collectRecordSecretValues(config.defaultArgs, secrets);
}

function collectTransportSecretValues(
  transport: McpResolvedTransportConfig | McpTransportConfig | undefined | null,
  secrets: Set<string>
): void {
  if (!transport) {
    return;
  }

  if (transport.type === 'http' || transport.type === 'sse') {
    collectRecordSecretValues(transport.headers, secrets);
    collectRawQuerySecretValues(transport.url, secrets);
    try {
      const parsed = new URL(transport.url);
      parsed.searchParams.forEach((value) => {
        addSecretValue(secrets, value);
      });
    } catch {
      // Ignore non-URL transport strings; normalized transports should already be valid URLs.
    }
    return;
  }

  if (transport.type === 'stdio') {
    collectRecordSecretValues(transport.env, secrets);
  }
}

function collectRawQuerySecretValues(url: string, secrets: Set<string>): void {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return;
  }

  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  for (const part of query.split('&')) {
    if (!part) {
      continue;
    }

    const valueStart = part.indexOf('=');
    const rawValue = valueStart === -1 ? '' : part.slice(valueStart + 1);
    if (!rawValue) {
      continue;
    }

    addSecretValue(secrets, rawValue);
    try {
      addSecretValue(secrets, decodeURIComponent(rawValue));
    } catch {
      // Ignore malformed percent-encoding; the raw value is still redacted.
    }
  }
}

function collectMcpSecretValues(sources: McpErrorRedactionSource[]): Set<string> {
  const secrets = new Set<string>();

  for (const source of sources) {
    collectUnknownSecretValues(source.values, secrets);
    collectCompiledConfigSecretValues(source.compiledConfig, secrets);
    collectTransportSecretValues(source.transport, secrets);
    for (const secret of source.extraSecrets || []) {
      collectUnknownSecretValues(secret, secrets);
    }
  }

  return secrets;
}

function redactSecretValues(value: string, secrets: Set<string>): string {
  return Array.from(secrets)
    .sort((a, b) => b.length - a.length)
    .reduce((current, secret) => current.split(secret).join(REDACTED_SHARED_SECRET), value);
}

function sanitizeUnknownValue(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === 'string') {
    return redactSecretValues(value, secrets);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknownValue(item, secrets));
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeUnknownValue(item, secrets)]));
}

export function sanitizeMcpErrorMessage(error: unknown, sources: McpErrorRedactionSource[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecretValues(message, collectMcpSecretValues(sources));
}

export function sanitizeMcpResult<T>(result: T, sources: McpErrorRedactionSource[] = []): T {
  return sanitizeUnknownValue(result, collectMcpSecretValues(sources)) as T;
}

export function redactSharedConfigSecrets<T extends { sharedConfig?: McpSharedConnectionConfig | null }>(config: T): T {
  const sharedConfig = config.sharedConfig ? { ...config.sharedConfig } : undefined;
  let changed = false;

  if (sharedConfig) {
    for (const section of SHARED_SECRET_SECTIONS) {
      const values = sharedConfig[section];
      if (!values || typeof values !== 'object') {
        continue;
      }

      sharedConfig[section] = Object.fromEntries(
        Object.keys(values).map((key) => [key, REDACTED_SHARED_SECRET])
      ) as Record<string, string>;
      changed = true;
    }
  }

  if (!changed) {
    return config;
  }

  return {
    ...config,
    ...(sharedConfig ? { sharedConfig } : {}),
  };
}

function redactSecretRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
  return values ? Object.fromEntries(Object.keys(values).map((key) => [key, REDACTED_SHARED_SECRET])) : values;
}

function redactTransportUrlQuery(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }

  const hashStart = url.indexOf('#', queryStart);
  const base = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const hash = hashStart === -1 ? '' : url.slice(hashStart);
  if (!query) {
    return url;
  }

  const redactedQuery = query
    .split('&')
    .map((part) => {
      if (!part) {
        return part;
      }

      const valueStart = part.indexOf('=');
      const key = valueStart === -1 ? part : part.slice(0, valueStart);
      return `${key}=${REDACTED_SHARED_SECRET}`;
    })
    .join('&');

  return `${base}?${redactedQuery}${hash}`;
}

export function redactMcpConfigSecrets<
  T extends { sharedConfig?: McpSharedConnectionConfig | null; transport?: McpTransportConfig | null }
>(config: T): T {
  const redacted = redactSharedConfigSecrets(config);
  if (!redacted.transport) {
    return redacted;
  }

  if (redacted.transport.type === 'http' || redacted.transport.type === 'sse') {
    const url = redactTransportUrlQuery(redacted.transport.url);
    if (!redacted.transport.headers && url === redacted.transport.url) {
      return redacted;
    }

    return {
      ...redacted,
      transport: {
        ...redacted.transport,
        url,
        ...(redacted.transport.headers ? { headers: redactSecretRecord(redacted.transport.headers) } : {}),
      },
    };
  }

  if (!redacted.transport.env) {
    return redacted;
  }

  return {
    ...redacted,
    transport: {
      ...redacted.transport,
      env: redactSecretRecord(redacted.transport.env),
    },
  };
}

export function restoreRedactedSharedConfig(
  nextSharedConfig: McpServerConfigRecord['sharedConfig'],
  existingSharedConfig: McpServerConfigRecord['sharedConfig']
): McpServerConfigRecord['sharedConfig'] {
  if (!nextSharedConfig || !existingSharedConfig) {
    return nextSharedConfig;
  }

  let changed = false;
  const sharedConfig = { ...nextSharedConfig };

  for (const section of SHARED_SECRET_SECTIONS) {
    const nextValues = sharedConfig[section];
    const existingValues = existingSharedConfig[section];
    if (!nextValues || !existingValues) {
      continue;
    }

    const restoredValues = { ...nextValues };
    for (const [key, value] of Object.entries(restoredValues)) {
      if (value === REDACTED_SHARED_SECRET && existingValues[key]) {
        restoredValues[key] = existingValues[key];
        changed = true;
      }
    }

    sharedConfig[section] = restoredValues;
  }

  return changed ? sharedConfig : nextSharedConfig;
}

function restoreRedactedSecretRecord(
  nextValues: Record<string, string> | undefined,
  existingValues: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!nextValues || !existingValues) {
    return nextValues;
  }

  let changed = false;
  const restoredValues = { ...nextValues };
  for (const [key, value] of Object.entries(restoredValues)) {
    if (value === REDACTED_SHARED_SECRET && existingValues[key]) {
      restoredValues[key] = existingValues[key];
      changed = true;
    }
  }

  return changed ? restoredValues : nextValues;
}

function parseUrlQueryParts(url: string): { base: string; query: string; hash: string } | null {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return null;
  }

  const hashStart = url.indexOf('#', queryStart);
  return {
    base: url.slice(0, queryStart),
    query: url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart),
    hash: hashStart === -1 ? '' : url.slice(hashStart),
  };
}

function restoreRedactedTransportUrlQuery(nextUrl: string, existingUrl: string): string {
  const nextParts = parseUrlQueryParts(nextUrl);
  const existingParts = parseUrlQueryParts(existingUrl);
  if (!nextParts || !existingParts || !nextParts.query || !existingParts.query) {
    return nextUrl;
  }

  const existingValuesByKey = new Map<string, string[]>();
  for (const part of existingParts.query.split('&')) {
    const valueStart = part.indexOf('=');
    if (valueStart === -1) {
      continue;
    }

    const key = part.slice(0, valueStart);
    const value = part.slice(valueStart + 1);
    existingValuesByKey.set(key, [...(existingValuesByKey.get(key) || []), value]);
  }

  let changed = false;
  const restoredQuery = nextParts.query
    .split('&')
    .map((part) => {
      const valueStart = part.indexOf('=');
      if (valueStart === -1) {
        return part;
      }

      const key = part.slice(0, valueStart);
      const value = part.slice(valueStart + 1);
      if (value !== REDACTED_SHARED_SECRET) {
        return part;
      }

      const existingValues = existingValuesByKey.get(key);
      const existingValue = existingValues?.shift();
      if (!existingValue) {
        return part;
      }

      changed = true;
      return `${key}=${existingValue}`;
    })
    .join('&');

  return changed ? `${nextParts.base}?${restoredQuery}${nextParts.hash}` : nextUrl;
}

export function transportTargetChanged(
  nextTransport: McpTransportConfig,
  existingTransport: McpTransportConfig
): boolean {
  if (nextTransport.type !== existingTransport.type) {
    return true;
  }

  if (nextTransport.type === 'http' || nextTransport.type === 'sse') {
    if (existingTransport.type !== 'http' && existingTransport.type !== 'sse') {
      return true;
    }

    try {
      const nextUrl = new URL(nextTransport.url);
      const existingUrl = new URL(existingTransport.url);
      return (
        nextUrl.protocol !== existingUrl.protocol ||
        nextUrl.host !== existingUrl.host ||
        nextUrl.pathname !== existingUrl.pathname
      );
    } catch {
      return nextTransport.url.split('?')[0] !== existingTransport.url.split('?')[0];
    }
  }

  if (existingTransport.type !== 'stdio') {
    return true;
  }

  return (
    nextTransport.command !== existingTransport.command ||
    JSON.stringify(nextTransport.args || []) !== JSON.stringify(existingTransport.args || [])
  );
}

function recordContainsRedactedSecret(values: Record<string, string> | undefined): boolean {
  return !!values && Object.values(values).some((value) => value === REDACTED_SHARED_SECRET);
}

function transportContainsRedactedSecret(transport: McpTransportConfig): boolean {
  if (transport.type === 'http' || transport.type === 'sse') {
    let redactedQueryValue = false;
    new URLSearchParams(parseUrlQueryParts(transport.url)?.query || '').forEach((value) => {
      if (value === REDACTED_SHARED_SECRET) {
        redactedQueryValue = true;
      }
    });
    return recordContainsRedactedSecret(transport.headers) || redactedQueryValue;
  }

  return recordContainsRedactedSecret(transport.env);
}

export function sharedConfigContainsRedactedSecret(sharedConfig: McpSharedConnectionConfig): boolean {
  return SHARED_SECRET_SECTIONS.some((section) => recordContainsRedactedSecret(sharedConfig[section]));
}

export function sharedConfigContainsSecretValue(sharedConfig: McpSharedConnectionConfig): boolean {
  return SHARED_SECRET_SECTIONS.some((section) => {
    const values = sharedConfig[section];
    return !!values && Object.values(values).length > 0;
  });
}

export function restoreRedactedTransport(
  nextTransport: McpTransportConfig,
  existingTransport: McpTransportConfig
): McpTransportConfig {
  if (nextTransport.type !== existingTransport.type) {
    if (transportContainsRedactedSecret(nextTransport)) {
      throw new Error('Re-enter MCP transport secrets when changing the MCP transport target');
    }

    return nextTransport;
  }

  if (nextTransport.type === 'http' || nextTransport.type === 'sse') {
    if (existingTransport.type !== 'http' && existingTransport.type !== 'sse') {
      return nextTransport;
    }

    if (transportTargetChanged(nextTransport, existingTransport) && transportContainsRedactedSecret(nextTransport)) {
      throw new Error('Re-enter MCP transport secrets when changing the MCP transport target');
    }

    const headers = restoreRedactedSecretRecord(nextTransport.headers, existingTransport.headers);
    const url = restoreRedactedTransportUrlQuery(nextTransport.url, existingTransport.url);
    return headers === nextTransport.headers && url === nextTransport.url
      ? nextTransport
      : { ...nextTransport, url, headers };
  }

  if (existingTransport.type !== 'stdio') {
    return nextTransport;
  }

  if (transportTargetChanged(nextTransport, existingTransport) && transportContainsRedactedSecret(nextTransport)) {
    throw new Error('Re-enter MCP transport secrets when changing the MCP transport target');
  }

  const env = restoreRedactedSecretRecord(nextTransport.env, existingTransport.env);
  return env === nextTransport.env ? nextTransport : { ...nextTransport, env };
}
