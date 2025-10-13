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
 * Creates a column name mapper for converting between camelCase property names
 * and snake_case database column names for specific fields.
 *
 * @param mappings - Object with camelCase keys and snake_case values
 * @returns Object with parse and format functions for Objection.js lifecycle hooks
 *
 * @example
 * ```typescript
 * static columnNameMappers = createColumnMapper({
 *   nodeSelector: 'node_selector',
 *   nodeAffinity: 'node_affinity',
 * });
 * ```
 */
export function createColumnMapper(mappings: Record<string, string>) {
  return {
    /**
     * Converts from database format (snake_case) to model format (camelCase)
     * Used in $parseDatabaseJson lifecycle hook
     */
    parse(obj: any): any {
      if (!obj) return obj;

      Object.entries(mappings).forEach(([camelCase, snake_case]) => {
        if (obj[snake_case] !== undefined) {
          obj[camelCase] = obj[snake_case];
          delete obj[snake_case];
        }
      });

      return obj;
    },

    /**
     * Converts from model format (camelCase) to database format (snake_case)
     * Used in $formatDatabaseJson lifecycle hook
     */
    format(obj: any): any {
      if (!obj) return obj;

      Object.entries(mappings).forEach(([camelCase, snake_case]) => {
        if (obj[camelCase] !== undefined) {
          obj[snake_case] = obj[camelCase];
          delete obj[camelCase];
        }
      });

      return obj;
    },
  };
}
