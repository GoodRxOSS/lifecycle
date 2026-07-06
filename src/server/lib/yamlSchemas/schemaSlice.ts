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

import { schema_1_0_0 } from './schema_1_0_0/schema_1_0_0';

type SchemaNode = Record<string, unknown>;

const MAX_SLICES = 4;
const MAX_TOTAL_CHARS = 1500;

// jsonschema errors read like `instance.services[0].github.repository is not of a type(s) string`
// or `instance.services[0] additionalProperty "dockerfle" exists in instance when not allowed`.
// At least one segment is required so the bare word "instance" inside error prose never matches.
const INSTANCE_PATH_RE = /\binstance((?:\.[A-Za-z0-9_-]+|\[\d+\])+)/g;

export function extractSchemaPathsFromValidationError(errorText: string): string[] {
  const paths = new Set<string>();
  for (const match of errorText.matchAll(INSTANCE_PATH_RE)) {
    const segments = match[1].split(/[.[\]]+/).filter((segment) => segment && !/^\d+$/.test(segment));
    if (segments.length > 0) {
      paths.add(segments.join('.'));
    }
  }
  return [...paths];
}

function resolveSchemaNode(path: string): { node: SchemaNode | null; resolvedPath: string } {
  let node: SchemaNode | null = schema_1_0_0 as SchemaNode;
  const resolved: string[] = [];

  for (const segment of path ? path.split('.') : []) {
    // Array indexes were stripped from the path; hop through `items` to the element schema.
    while (node && typeof node.items === 'object' && node.items !== null) {
      node = node.items as SchemaNode;
    }
    const properties = node?.properties as Record<string, SchemaNode> | undefined;
    const next = properties?.[segment];
    if (!next) {
      break;
    }
    node = next;
    resolved.push(segment);
  }

  return { node, resolvedPath: resolved.join('.') };
}

function describeSchemaNode(node: SchemaNode): string {
  const parts: string[] = [];
  if (typeof node.type === 'string') {
    parts.push(`type=${node.type}`);
  }
  if (Array.isArray(node.enum)) {
    parts.push(`enum=[${node.enum.join(', ')}]`);
  }
  if (typeof node.format === 'string') {
    parts.push(`format=${node.format}`);
  }
  for (const key of ['minLength', 'minimum', 'maximum'] as const) {
    if (node[key] !== undefined) {
      parts.push(`${key}=${node[key]}`);
    }
  }
  if (Array.isArray(node.required) && node.required.length > 0) {
    parts.push(`required=[${node.required.join(', ')}]`);
  }
  const itemsNode = node.items as SchemaNode | undefined;
  if (itemsNode && typeof itemsNode === 'object') {
    parts.push(`items: ${describeSchemaNode(itemsNode)}`);
  }
  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties) {
    parts.push(`allowed fields: ${Object.keys(properties).join(', ')}`);
  }
  if (node.additionalProperties === false) {
    parts.push('(unknown fields rejected)');
  }
  return parts.join(', ') || 'object';
}

/**
 * Renders the lifecycle.yaml schema slices relevant to a jsonschema validation error, so a model
 * (or a human) sees the valid shape of exactly the failing paths instead of the whole schema.
 * Returns null when the text carries no recognizable schema paths.
 */
export function renderLifecycleSchemaSlices(errorText: string): string | null {
  const paths = extractSchemaPathsFromValidationError(errorText);
  if (paths.length === 0) {
    return null;
  }

  const lines: string[] = [];
  for (const path of paths.slice(0, MAX_SLICES)) {
    const { node, resolvedPath } = resolveSchemaNode(path);
    if (!node) {
      continue;
    }
    const label = resolvedPath || '(root)';
    const suffix = resolvedPath === path ? '' : ` (nearest schema match for ${path || '(root)'})`;
    lines.push(`- ${label}${suffix}: ${describeSchemaNode(node)}`);
  }
  if (paths.length > MAX_SLICES) {
    lines.push(`- (+${paths.length - MAX_SLICES} more failing paths)`);
  }

  if (lines.length === 0) {
    return null;
  }

  const rendered = lines.join('\n');
  return rendered.length > MAX_TOTAL_CHARS ? `${rendered.slice(0, MAX_TOTAL_CHARS)}…` : rendered;
}
