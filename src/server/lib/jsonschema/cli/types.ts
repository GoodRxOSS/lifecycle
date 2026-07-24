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

export type JSONSchema = {
  type: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  $defs?: Record<string, JSONSchema>;
  [key: string]: unknown;
};

export type Options = {
  debug?: boolean;
};

export type ReadJsonSchemaOptions = {
  input: string;
  debug: boolean;
};

export type WriteYamlOptions = {
  yamlOutput: string;
  output: string;
  debug: boolean;
};

export type ReadExistingSchemaOptions = {
  output: string;
  debug: boolean;
};

export type WriteJsonSchemaOptions = {
  schema: JSONSchema;
  output: string;
  debug: boolean;
};

export type ProcessSchemaOptions = {
  schema: JSONSchema;
  path?: string[];
  isTopLevel?: boolean;
  indent?: number;
  parentType?: string;
};
