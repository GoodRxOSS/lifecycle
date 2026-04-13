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

type JsonSchemaLike = Record<string, unknown>;

function asSchemaPropertyMap(inputSchema: JsonSchemaLike): Record<string, unknown> {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return {};
  }

  return properties as Record<string, unknown>;
}

function coerceDefaultValue(rawValue: string, schemaProperty: unknown): unknown {
  if (!schemaProperty || typeof schemaProperty !== 'object' || Array.isArray(schemaProperty)) {
    return rawValue;
  }

  const property = schemaProperty as { type?: unknown };

  if (property.type === 'boolean') {
    if (rawValue === 'true') {
      return true;
    }
    if (rawValue === 'false') {
      return false;
    }
    return rawValue;
  }

  if (property.type === 'integer' || property.type === 'number') {
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : rawValue;
  }

  return rawValue;
}

export function applyMcpDefaultToolArgs(
  inputSchema: JsonSchemaLike,
  defaultArgs: Record<string, string> | undefined,
  inputArgs: Record<string, unknown> | undefined
): Record<string, unknown> {
  const args = { ...(inputArgs || {}) };
  const schemaProperties = asSchemaPropertyMap(inputSchema);

  if (Object.keys(schemaProperties).length === 0 || !defaultArgs || Object.keys(defaultArgs).length === 0) {
    return args;
  }

  for (const [key, rawValue] of Object.entries(defaultArgs)) {
    if (!(key in schemaProperties) || args[key] !== undefined) {
      continue;
    }

    args[key] = coerceDefaultValue(rawValue, schemaProperties[key]);
  }

  return args;
}
