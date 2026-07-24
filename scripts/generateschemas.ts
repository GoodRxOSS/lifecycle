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

import { execSync } from 'child_process';
import fs from 'fs';

export function detectSchemaVersions(): string[] {
  const yamlSchemasDir = './src/server/lib/yamlSchemas';
  const schemaFolders = fs
    .readdirSync(yamlSchemasDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory() && dirent.name.startsWith('schema_'))
    .map((dirent) => dirent.name);

  const versions = schemaFolders.map((folder) => {
    const versionParts = folder.replace('schema_', '').split('_');
    return versionParts.join('.');
  });

  const sortedVersions = versions.sort((a, b) => {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);

    const maxLength = Math.max(aParts.length, bParts.length);
    const paddedA = [...aParts, ...Array(maxLength - aParts.length).fill(0)];
    const paddedB = [...bParts, ...Array(maxLength - bParts.length).fill(0)];

    const diffIndex = paddedA.findIndex((val, idx) => val !== paddedB[idx]);
    return diffIndex === -1 ? 0 : paddedA[diffIndex] - paddedB[diffIndex];
  });
  return sortedVersions;
}

const SCHEMA_VERSIONS = detectSchemaVersions();
console.log('Detected schema versions:', SCHEMA_VERSIONS);

const YAML_SCHEMA_BASE = './src/server/lib/jsonschema/schemas';
const JSON_SCHEMA_BASE = './src/server/lib/yamlSchemas';
const DOCS_YAML = './docs/schema/yaml';

const BASE_GENERATE_YAML = 'tsx ./src/server/lib/jsonschema/cli/index.ts generate-yaml';
const BASE_GENERATE_JSON = 'tsx ./src/server/lib/jsonschema/cli/index.ts generate-jsonschema';

export function runCommand(command: string) {
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (error) {
    console.error(`Error running command: ${command}`);
    process.exit(1);
  }
}

export function generateJsonSchemas() {
  SCHEMA_VERSIONS.forEach((version) => {
    const versionText = version.split('.').join('_');
    const input = `${JSON_SCHEMA_BASE}/schema_${versionText}/schema_${versionText}.ts`;
    const output = `${YAML_SCHEMA_BASE}/${version}.json`;
    const command = `${BASE_GENERATE_JSON} ${input} ${output} --debug`;
    runCommand(command);

    updateVersionComment(output);
  });
}

export function updateVersionComment(schemaPath: string) {
  try {
    const versionListStr = `[${SCHEMA_VERSIONS.join(', ')}]`;

    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    if (schema?.properties?.version) {
      schema.properties.version.comment = `One of ${versionListStr}`;

      fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf8');
      console.log(`Updated version comment in ${schemaPath}`);
    }
  } catch (error) {
    console.error(`Error updating version comment in ${schemaPath}:`, error);
  }
}

export function generateYamlSchemas() {
  SCHEMA_VERSIONS.forEach((version) => {
    const input = `${YAML_SCHEMA_BASE}/${version}.json`;
    const output = `${DOCS_YAML}/${version}.yaml`;
    const command = `${BASE_GENERATE_YAML} ${input} ${output} --debug`;
    runCommand(command);
  });
  console.log('\x1b[33m%s\x1b[0m', '👋 Remember to update docs/_lifecycle.doc.yaml with any new schema changes!');
}

const action = process.argv[2];

switch (action) {
  case 'generatejson':
    generateJsonSchemas();
    break;
  case 'generateyaml':
    generateYamlSchemas();
    break;
  default:
    console.log('Usage: tsx ./scripts/generateSchemas.ts generatejson|generateyaml');
    process.exit(1);
}
