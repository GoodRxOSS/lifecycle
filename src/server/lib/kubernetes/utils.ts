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

/**
 * Normalizes a string to be valid for Kubernetes labels.
 * Kubernetes label values must match the regex: (([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?
 * This means they must start and end with alphanumeric characters, and can contain
 * hyphens, underscores, and dots in the middle.
 */
export function normalizeKubernetesLabelValue(value: string): string {
  if (!value) return '';

  // replace invalid characters with hyphens
  let normalized = value.replace(/[^A-Za-z0-9\-_.]/g, '-');

  // remove leading/trailing non-alphanumeric characters
  normalized = normalized.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

  // if empty return 'unknown'
  if (!normalized) {
    return 'unknown';
  }

  // truncate if too long (k8s labels have a 63 character limit)
  if (normalized.length > 63) {
    normalized = normalized.substring(0, 63);
    // handle trailing non-alphanumeric after truncate
    normalized = normalized.replace(/[^A-Za-z0-9]+$/, '');
  }

  return normalized;
}
