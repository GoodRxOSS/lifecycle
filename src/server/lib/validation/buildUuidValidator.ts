/**
 * Copyright 2026 Lifecycle contributors
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

export const BUILD_UUID_PATTERN = '^[a-z0-9-]+$';
export const BUILD_UUID_MIN_LENGTH = 3;
export const BUILD_UUID_MAX_LENGTH = 50;

export function validateBuildUuidFormat(uuid: string): string | null {
  if (uuid.length < BUILD_UUID_MIN_LENGTH || uuid.length > BUILD_UUID_MAX_LENGTH) {
    return 'UUID must be between 3 and 50 characters';
  }

  if (!new RegExp(BUILD_UUID_PATTERN).test(uuid)) {
    return 'UUID can only contain lowercase letters, numbers, and hyphens';
  }

  if (uuid.startsWith('-') || uuid.endsWith('-')) {
    return 'UUID cannot start or end with a hyphen';
  }

  return null;
}
