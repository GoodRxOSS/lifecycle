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

// SECURITY: precise, prefix/assignment-anchored credential scrubbing so chain-of-thought
// reasoning never persists a secret at rest. Patterns avoid bare 40-hex git SHAs and prose.

const PLACEHOLDER = '[redacted]';

// Token-shaped secrets anchored on a known, distinctive prefix.
const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth / app tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic (matched before generic sk-)
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style
  /\bAIza[A-Za-z0-9_-]{30,}\b/g, // Google API key
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
];

// Authorization headers: keep the scheme, redact the credential.
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g;

// Keyed assignments (`KEY=value`, `KEY: "value"`): keep the key + operator, redact the value.
// Covers the Lifecycle gateway token (named + 64-hex value) and aws_secret_access_key.
const ASSIGNMENT_PATTERN =
  /\b(TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD|PASSWD|CREDENTIALS?|LIFECYCLE_GATEWAY_TOKEN|AWS_SECRET_ACCESS_KEY)\b(["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;

/** Replace detected credentials in free text with `[redacted]`. Pure; safe on any string. */
export function scrubSecretsFromText(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, PLACEHOLDER);
  }
  result = result.replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${PLACEHOLDER}`);
  result = result.replace(ASSIGNMENT_PATTERN, (_match, key: string, op: string) => `${key}${op}${PLACEHOLDER}`);
  return result;
}
