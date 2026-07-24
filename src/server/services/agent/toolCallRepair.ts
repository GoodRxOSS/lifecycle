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

// Gemini frequently calls workspace tools under mangled names — provider-invented namespaces like
// `default_api:mcp__workspace_core__exec` or the bare `exec` — which raise NoSuchToolError and send
// the model into a retry spiral (each failed attempt reasons + retries, inflating the run until the
// token budget trips). Map a mangled name back to the real registered key so the call just runs.
//
// Only genuine mangling is repaired: a request that already equals a registered key is left alone
// (its NoSuchToolError means the tool is intentionally inactive for this step — e.g. the budget-forced
// final-answer step — and must not be silently reactivated).

const PROVIDER_NAMESPACE_PREFIX = /^(?:default_api|functions|tools|tool|mcp|api)[.:]+/i;

function stripProviderNamespace(name: string): string {
  let previous: string;
  let current = name.trim();
  do {
    previous = current;
    current = current.replace(PROVIDER_NAMESPACE_PREFIX, '');
  } while (current !== previous);
  return current;
}

export function repairAgentToolName(requestedName: string, registeredToolKeys: Iterable<string>): string | null {
  const keys = registeredToolKeys instanceof Set ? registeredToolKeys : new Set(registeredToolKeys);

  // Exact match already — the tool exists but is inactive for this step; do not reactivate it.
  if (keys.has(requestedName)) {
    return null;
  }

  // The model frequently prepends a namespace segment before the real `mcp__<server>__<tool>` key —
  // a provider namespace (default_api:mcp__…) or the chat/session slug (chat-a6534157__mcp__…, which
  // sanitizes to chat_a6534157__mcp__…). Anchor on the real key by taking from the first `mcp__`.
  const mcpIndex = requestedName.indexOf('mcp__');
  if (mcpIndex > 0) {
    const fromMcp = requestedName.slice(mcpIndex);
    if (fromMcp !== requestedName && keys.has(fromMcp)) {
      return fromMcp;
    }
  }

  const stripped = stripProviderNamespace(requestedName);
  if (stripped === requestedName) {
    // Nothing was mangled; the name simply does not resolve. Leave it for the caller to surface.
    // Fall through to suffix matching below only for a truly different short name.
  } else if (keys.has(stripped)) {
    return stripped;
  }

  // The model dropped the `mcp__<server>__` prefix and used the bare tool name (e.g. `exec`).
  // Accept only when it resolves to exactly one registered key to avoid guessing between tools.
  const bareName = stripped;
  if (bareName && !bareName.includes('__')) {
    const suffixMatches = [...keys].filter((key) => key.endsWith(`__${bareName}`));
    if (suffixMatches.length === 1) {
      return suffixMatches[0];
    }
  }

  return null;
}
