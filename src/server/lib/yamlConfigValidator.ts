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

import { LifecycleConfig } from 'server/models/yaml/Config';
import { LifecycleError } from './errors';
import JsonSchema from 'jsonschema';
import { BuildStatus, CAPACITY_TYPE, DiskAccessMode } from 'shared/constants';
import { schema_1_0_0 } from './yamlSchemas';
import { getLogger } from 'server/lib/logger';

export class ValidationError extends LifecycleError {
  constructor(msg: string, uuid: string = null, service: string = null) {
    super(uuid, service, msg);
  }

  public getRawMessage(): string {
    let message: string = '';

    message += 'Invalid YAML Configuration Syntax:\n';
    message += this.message;

    return message;
  }
}

JsonSchema.Validator.prototype.customFormats.webhookType = (input) => {
  const validTypes = ['codefresh', 'docker', 'command'];
  return validTypes.includes(input);
};
JsonSchema.Validator.prototype.customFormats.webhookState = (input) => {
  let result: boolean = false;

  for (const [, value] of Object.entries(BuildStatus)) {
    if (value.toLowerCase() === input.toLowerCase()) {
      result = true;
      break;
    }
  }

  return result;
};
JsonSchema.Validator.prototype.customFormats.diskAccessMode = (input) => {
  let result: boolean = false;

  for (const [, value] of Object.entries(DiskAccessMode)) {
    if (value.toLowerCase() === input.toLowerCase()) {
      result = true;
      break;
    }
  }

  return result;
};

JsonSchema.Validator.prototype.customFormats.capacityType = (input) => {
  let result: boolean = false;

  for (const [, value] of Object.entries(CAPACITY_TYPE)) {
    if (value.toLowerCase() === input.toLowerCase()) {
      result = true;
      break;
    }
  }

  return result;
};

export class YamlConfigValidator {
  public validate(version: string = 'latest', yamlConfig: LifecycleConfig): boolean {
    let isValid: boolean = true;
    if (yamlConfig === undefined || yamlConfig === null) {
      throw new ValidationError('Config file is empty.');
    }

    getLogger().debug(`Config: validating version=${version}`);
    switch (version.toLowerCase()) {
      case '1.0.0':
      case 'latest':
      default:
        isValid = this.validate_1_0_0(yamlConfig);
        break;
    }

    return isValid;
  }

  validate_1_0_0(config: LifecycleConfig): boolean {
    const validator = new JsonSchema.Validator();
    const validationResult: JsonSchema.ValidatorResult = validator.validate(config, schema_1_0_0, {
      allowUnknownAttributes: false,
      nestedErrors: true,
    });
    if (!validationResult.valid) {
      throw new ValidationError(validationResult.errors.join('\n'));
    }

    return true;
  }
}
