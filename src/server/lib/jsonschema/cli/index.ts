#!/usr/bin/env node
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


import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { isEqual, merge } from 'lodash';
import {
  JSONSchema,
  Options,
  ReadJsonSchemaOptions,
  ReadExistingSchemaOptions,
  WriteJsonSchemaOptions,
  WriteYamlOptions,
} from 'server/lib/jsonschema/cli/types';

export const generateJsonSchema = (input: string, output: string, options: Options): void => {
  try {
    const { debug = false } = options;
    const sanitizedInput = input.endsWith('.ts') ? input.split('.ts')[0] : input;
    const incomingSchema = readJsonSchema({
      input: sanitizedInput,
      debug,
    });
    const existingSchema = readExistingSchema({
      output,
      debug,
    });
    const mergedSchema = mergeExistingWithIncoming(existingSchema, incomingSchema, debug);
    writeJsonSchema({
      schema: mergedSchema,
      output,
      debug,
    });
  } catch (error) {
    console.error('Unexpected error during lifecycle:', error);
    process.exit(1);
  }
};

export const readJsonSchema = ({ input, debug }: ReadJsonSchemaOptions): JSONSchema => {
  try {
    const schemaModule = require(path.resolve(input));
    const schemaVersion = Object.keys(schemaModule).find((key) => key.startsWith('schema_'));
    const schema = schemaVersion ? schemaModule[schemaVersion] : schemaModule.default || schemaModule;

    if (!schema || typeof schema !== 'object') {
      throw new Error('No valid JSON schema found in the input file.');
    }

    return schema as JSONSchema;
  } catch (error) {
    if (debug) console.error('Error reading incoming JSON schema:', error.message);
    throw new Error(`Error reading JSON schema from ${input}: ${error.message}`);
  }
};

export const jsonSchemaToYaml = (schema: JSONSchema): string => {
  const processSchema = (
    schema: JSONSchema,
    path: string[] = [],
    isTopLevel = false,
    indent = 0,
    parentRequired: string[] = []
  ): string => {
    if (!schema.properties) return '';

    const indentation = ' '.repeat(indent);
    const listItemIndent = ' '.repeat(indent + 2);

    return Object.entries(schema.properties)
      .map(([key, value]) => {
        const propertyPath = [...path, key];
        const fullPath = propertyPath.join('.');

        const isRequired = parentRequired.includes(key);
        const requiredLabel = isRequired ? ' (required)' : '';

        const lines: string[] = [];

        // Add @section only at the top level
        if (isTopLevel) {
          lines.push(`${indentation}# @section ${key}${value.comment ? ` ${value.comment}` : ''}`);
        }

        if (value.type === 'object') {
          if (!isTopLevel) {
            lines.push(`${indentation}# @param ${fullPath}${requiredLabel}${value.comment ? ` ${value.comment}` : ''}`);
          }
          lines.push(`${indentation}${key}:`);
          lines.push(processSchema(value, propertyPath, false, indent + 2, (value.required || []) as any));
        } else if (value.type === 'array') {
          const isObject = value?.items && value?.items?.type === 'object';

          if (!isTopLevel) {
            lines.push(`${indentation}# @param ${fullPath}${requiredLabel}${value.comment ? ` ${value.comment}` : ''}`);
          }
          lines.push(`${indentation}${key}:`);

          if (isObject) {
            // Object array: Place @param before the list item
            lines.push(`${listItemIndent}# @param ${fullPath}[]${requiredLabel}`);
            lines.push(`${listItemIndent}-`);
            lines.push(
              processSchema(
                value?.items as JSONSchema,
                propertyPath,
                false,
                indent + 4,
                (value.items.required || []) as any
              )
            );
          } else {
            // Primitive array: Place @param **above** the `-`
            lines.push(`${listItemIndent}# @param ${fullPath}[]${requiredLabel}`);
            const placeholder = getDefaultPlaceholder(value.items?.type || 'string');
            lines.push(`${listItemIndent}- ${placeholder}`);
          }
        } else if (key === 'version') {
          if (!isTopLevel) {
            lines.push(`${indentation}# @param ${fullPath}${requiredLabel}${value.comment ? ` ${value.comment}` : ''}`);
          }
          const version = value?.format
            ? (value.format as string).replace('schema', '').replace('Version', '').split('').join('.')
            : '';

          lines.push(`${indentation}${key}: '${version}'`);
        } else {
          if (!isTopLevel) {
            lines.push(`${indentation}# @param ${fullPath}${requiredLabel}${value.comment ? ` ${value.comment}` : ''}`);
          }
          const defaultValue = value.default !== undefined ? value.default : getDefaultPlaceholder(value.type);
          lines.push(`${indentation}${key}: ${defaultValue}`);
        }

        return lines.join('\n');
      })
      .join('\n');
  };

  return processSchema(schema, [], true, 0, (schema.required as any) || []);
};

const getDefaultPlaceholder = (type: string): string => {
  switch (type) {
    case 'string':
      return `''`;
    case 'number':
    case 'integer':
      return '0';
    case 'boolean':
      return 'false';
    case 'array':
      return '[]';
    case 'object':
      return '{}';
    default:
      return 'null';
  }
};

export const writeYaml = ({ yamlOutput, output, debug }: WriteYamlOptions): void => {
  try {
    const outputDir = path.dirname(output);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    if (debug) console.log(`Ensured output directory exists: ${outputDir}`);

    fs.writeFileSync(output, yamlOutput, 'utf-8');
    if (debug) console.log(`YAML written to: ${output}`);
  } catch (error) {
    if (debug) console.error('Error writing YAML:', error);
    process.exit(1);
  }
};

export const readExistingSchema = ({ output, debug }: ReadExistingSchemaOptions): JSONSchema | null => {
  try {
    if (fs.existsSync(output)) {
      const schema = JSON.parse(fs.readFileSync(output, 'utf-8')) as JSONSchema;
      if (debug) console.log('Loaded existing JSON schema');
      return schema;
    }
    if (debug) console.log('No existing JSON schema found. Starting with an empty schema.');
    return null;
  } catch (error) {
    if (debug) console.error('Error reading existing JSON schema:', error);
    process.exit(1);
  }
};

export const mergeExistingWithIncoming = (
  existing: JSONSchema | null,
  incoming: JSONSchema,
  debug: boolean
): JSONSchema => {
  if (!existing) {
    if (debug) console.log('No existing schema found. Using the incoming schema as is.');
    return incoming;
  }

  const mergedSchema = merge({}, existing, incoming);

  if (debug && !isEqual(existing, incoming)) {
    console.log('Differences:');
    logDifferences(existing, incoming);
  }

  return mergedSchema;
};

const logDifferences = (existing: JSONSchema, incoming: JSONSchema, parentKey = ''): void => {
  return Object.keys({
    ...existing,
    ...incoming,
  }).forEach((key) => {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(existing, key)) {
      console.log(`Added: ${fullKey}`);
    } else if (!Object.prototype.hasOwnProperty.call(incoming, key)) {
      console.log(`Removed: ${fullKey}`);
    } else if (!isEqual(existing[key], incoming[key])) {
      console.log(`Changed: ${fullKey}`);
    }
  });
};

export const writeJsonSchema = ({ schema, output, debug }: WriteJsonSchemaOptions): void => {
  try {
    const outputDir = path.dirname(output);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(output, JSON.stringify(schema, null, 2), 'utf-8');
  } catch (error) {
    if (debug) console.error('Error writing JSON schema:', error);
    process.exit(1);
  }
};

export const generateYamlWithComments = (input: string, output: string, options: { debug: boolean }): void => {
  try {
    const { debug } = options;
    const schema = readJsonSchema({ input, debug });
    const yamlOutput = jsonSchemaToYaml(schema);
    const sanitizedOutput = output.endsWith('.yaml') ? output : `${output}.yaml`;
    writeYaml({
      yamlOutput,
      output: sanitizedOutput,
      debug,
    });
  } catch (error) {
    console.error('Unexpected error during YAML generation:', error);
    process.exit(1);
  }
};

export const program = new Command();

program.name('json-schema-diff').description('A CLI for diffing and merging JSON schemas.').version('0.0.1');

program
  .command('generate-jsonschema <input> <output>')
  .description('Diff an incoming JSON schema with an existing one and merge changes.')
  .option('-d, --debug', 'Enable debug mode', false)
  .action(generateJsonSchema);

program
  .command('generate-yaml <input> <output>')
  .description('Generate YAML with comments from a JSON schema.')
  .option('-d, --debug', 'Enable debug mode', false)
  .action(generateYamlWithComments);

program.parse(process.argv);
