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

var mockDebug: jest.Mock;

jest.mock('server/lib/logger', () => {
  mockDebug = jest.fn();
  return { getLogger: () => ({ debug: mockDebug }) };
});

import JsonSchema from 'jsonschema';
import { BuildStatus, CAPACITY_TYPE, DiskAccessMode } from 'shared/constants';
import { ValidationError, YamlConfigValidator } from '../yamlConfigValidator';

const validConfig = {
  version: '1.0.0',
  services: [{ name: 'web' }],
};

function customFormat(name: string): (input: string) => boolean {
  return (JsonSchema.Validator.prototype.customFormats as Record<string, (input: string) => boolean>)[name];
}

describe('YamlConfigValidator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([undefined, null])('rejects an empty configuration before schema validation', (config) => {
    expect(() => new YamlConfigValidator().validate('latest', config as never)).toThrow('Config file is empty.');
    expect(mockDebug).not.toHaveBeenCalled();
  });

  it.each([undefined, 'latest', '1.0.0', 'future-version'])(
    'validates the current schema for version %p',
    (version) => {
      expect(new YamlConfigValidator().validate(version, validConfig as never)).toBe(true);
      expect(mockDebug).toHaveBeenLastCalledWith(`Config: validating version=${version ?? 'latest'}`);
    }
  );

  it('throws a typed validation error containing all schema failures', () => {
    expect(() =>
      new YamlConfigValidator().validate('1.0.0', {
        version: '1.0.0',
        services: 5,
        unknownRootField: true,
      } as never)
    ).toThrow(ValidationError);

    try {
      new YamlConfigValidator().validate_1_0_0({ version: '1.0.0', services: 5 } as never);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain('services');
      expect((error as ValidationError).getRawMessage()).toBe(
        `Invalid YAML Configuration Syntax:\n${(error as ValidationError).message}`
      );
    }
  });

  it.each(['codefresh', 'docker', 'command'])('accepts supported webhook type %s', (value) => {
    expect(customFormat('webhookType')(value)).toBe(true);
  });

  it('rejects unsupported and case-mismatched webhook types', () => {
    expect(customFormat('webhookType')('CODEFRESH')).toBe(false);
    expect(customFormat('webhookType')('unknown')).toBe(false);
  });

  it.each([
    ['webhookState', Object.values(BuildStatus)[0]],
    ['diskAccessMode', Object.values(DiskAccessMode)[0]],
    ['capacityType', Object.values(CAPACITY_TYPE)[0]],
  ])('accepts %s values case-insensitively', (format, value) => {
    expect(customFormat(format)(String(value).toUpperCase())).toBe(true);
  });

  it.each(['webhookState', 'diskAccessMode', 'capacityType'])('rejects an unknown %s value', (format) => {
    expect(customFormat(format)('definitely-not-valid')).toBe(false);
  });
});
