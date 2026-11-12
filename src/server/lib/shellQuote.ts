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

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./~-]+$/;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function quoteIfNeeded(value: string): string {
  return SAFE_SHELL_WORD.test(value) ? value : shellQuote(value);
}

// Kubernetes expands $(VAR) and turns $$ into $ in container args and env values, so every
// user-controlled `$` must be doubled for the container to receive the original text.
export function escapeK8sDollar(value: string): string {
  return value.replace(/\$/g, '$$$$');
}

export function quoteForJobScript(value: string): string {
  return escapeK8sDollar(quoteIfNeeded(value));
}
