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

type NativeImport = <T>(specifier: string) => Promise<T>;
type NodeRequire = <T = unknown>(specifier: string) => T;

// Preserve native import() when tsconfig.server emits CommonJS for ESM-only packages.
const nativeImport = new Function('specifier', 'return import(specifier);') as NativeImport;
const testRequire = typeof require === 'function' ? (require as NodeRequire) : null;

export async function importEsm<T>(specifier: string): Promise<T> {
  if (process.env.NODE_ENV === 'test' && testRequire) {
    try {
      return testRequire<T>(specifier);
    } catch (error) {
      if (!(error instanceof Error) || !/ERR_REQUIRE_ESM|Cannot use import statement/.test(error.message)) {
        throw error;
      }
    }
  }

  return nativeImport<T>(specifier);
}
