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

import _ from 'lodash';
import * as mustache from 'mustache';

import Database from 'server/database';
import { Build, Deploy } from 'server/models';
import {
  DeployTypes,
  FeatureFlags,
  HYPHEN_REPLACEMENT,
  HYPHEN_REPLACEMENT_REGEX,
  NO_DEFAULT_ENV_UUID,
} from 'shared/constants';

import rootLogger from 'server/lib/logger';
import { LifecycleError } from './errors';
import GlobalConfigService from 'server/services/globalConfig';

// eslint-disable-next-line no-unused-vars
const logger = rootLogger.child({
  filename: 'lib/envVariables.ts',
});

const ALLOWED_PROPERTIES = [
  'branchName',
  'ipAddress',
  'publicUrl',
  'UUID',
  'internalHostname',
  'dockerImage',
  'initDockerImage',
  'sha',
  'namespace',
];

export abstract class EnvironmentVariables {
  db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Takes a k/v environment and replaces any keys that have hyphens with our special replacement token
   * @param environment The environment we're temporarily modifying to make it friendly for lodash templates
   */
  cleanup(environment: Record<string, any>): Record<string, any> {
    if (environment != null) {
      Object.keys(environment).forEach((key) => {
        environment[key.replace(/-/g, HYPHEN_REPLACEMENT)] = environment[key];
      });
    }
    return environment;
  }

  async buildEnvironmentVariableDictionary(
    deploys: Deploy[],
    buildUUID: string,
    fullYamlSupport: boolean,
    build: Build,
    additionalVariables?: Record<string, any>
  ): Promise<Record<string, any>> {
    let availableEnv: Record<string, any>;

    if (fullYamlSupport) {
      availableEnv = deploys
        .filter((deploy) => {
          return deploy.deployable?.type !== DeployTypes.CONFIGURATION;
        })
        .reduce((env, deploy) => {
          const serviceEnv: Array<[string, string]> = ALLOWED_PROPERTIES.map((prop) => {
            let propValue = null;
            if (deploy.active) {
              propValue = deploy[prop];
              if (prop === 'UUID') {
                propValue = deploy.deployable.buildUUID;
              }
            } else {
              if (prop === 'UUID') {
                propValue = deploy.deployable.defaultUUID;
              } else if (prop === 'publicUrl') {
                propValue = deploy.deployable.defaultPublicUrl;
              } else if (prop === 'internalHostname') {
                if (
                  Array.isArray(build?.enabledFeatures) &&
                  build.enabledFeatures.includes(FeatureFlags.NO_DEFAULT_ENV_RESOLVE)
                ) {
                  propValue = NO_DEFAULT_ENV_UUID;
                } else {
                  propValue = deploy.deployable.defaultInternalHostname;
                }
              } else {
                propValue = '';
              }
            }
            return [`${deploy.deployable.name.replace(/-/g, HYPHEN_REPLACEMENT)}_${prop}`, propValue];
          });

          if (deploy.deployable.hostPortMapping && Object.keys(deploy.deployable.hostPortMapping).length > 0) {
            Object.keys(deploy.deployable.hostPortMapping).forEach((key) => {
              const propValue = deploy.active ? `${key}-${deploy.publicUrl}` : deploy.deployable.defaultPublicUrl;
              serviceEnv.push([
                `${key}-${deploy.deployable.name.replace(/-/g, HYPHEN_REPLACEMENT)}_publicUrl`,
                propValue,
              ]);
            });
          }
          return {
            ...env,
            ...Object.fromEntries(serviceEnv),
          };
        }, {});
    } else {
      availableEnv = deploys
        .filter((deploy) => {
          return deploy.service?.type !== DeployTypes.CONFIGURATION;
        })
        .reduce((env, deploy) => {
          const serviceEnv: Array<[string, string]> = ALLOWED_PROPERTIES.map((prop) => {
            let propValue = null;
            if (deploy.active) {
              propValue = deploy[prop];
              if (prop === 'UUID') {
                propValue = buildUUID;
              }
            } else {
              if (prop === 'UUID') {
                propValue = deploy.service.defaultUUID;
              } else if (prop === 'publicUrl') {
                propValue = deploy.service.defaultPublicUrl;
              } else if (prop === 'internalHostname') {
                propValue = deploy.service.defaultInternalHostname;
              } else {
                propValue = '';
              }
            }
            return [`${deploy.service.name.replace(/-/g, HYPHEN_REPLACEMENT)}_${prop}`, propValue];
          });

          if (deploy.service.hostPortMapping && Object.keys(deploy.service.hostPortMapping).length > 0) {
            Object.keys(deploy.service.hostPortMapping).forEach((key) => {
              const propValue = deploy.active ? `${key}-${deploy.publicUrl}` : deploy.service.defaultPublicUrl;
              serviceEnv.push([`${key}-${deploy.service.name.replace(/-/g, HYPHEN_REPLACEMENT)}_publicUrl`, propValue]);
            });
          }
          return {
            ...env,
            ...Object.fromEntries(serviceEnv),
          };
        }, {});
    }

    // Grab any configuration types and merge them into the available environment
    const configurationServiceEnvironments = await this.configurationServiceEnvironments(deploys, fullYamlSupport);

    configurationServiceEnvironments.forEach((configuration) => {
      availableEnv = _.assign(availableEnv, configuration);
    });

    if (additionalVariables != null) {
      availableEnv = { ...availableEnv, ...additionalVariables };
    }

    return availableEnv;
  }

  /**
   * Building a dictionary of available environment variables for envVar template
   * @param deploys List of services to deploy
   * @param build The LC build
   * @returns A dictionary of available environment variables key/value pair
   */
  async availableEnvironmentVariablesForBuild(build: Build): Promise<Record<string, any>> {
    let availableEnv: Record<string, any>;

    if (build == null) {
      throw Error(
        'Critical problem. Attempt retrieving environment Variables from empty build, which should NEVER happen.'
      );
    }

    await build?.$fetchGraph('[deploys.[service, deployable], pullRequest]');
    const deploys = build?.deploys;

    if (deploys == null) {
      throw new LifecycleError(
        build.runUUID,
        '',
        'Critical problem. Missing associated deploys with the build, which should NEVER happen.'
      );
    }

    availableEnv = await this.buildEnvironmentVariableDictionary(deploys, build.uuid, build.enableFullYaml, build, {
      buildUUID: build.uuid,
      buildSHA: build.sha,
      pullRequestNumber: build.pullRequest?.pullRequestNumber,
      namespace: build.namespace,
    });

    return availableEnv;
  }

  /**
   * Returns all of the configuration blocks for the given list of deploys
   * @param deploys the deploys to return configuration blocks for
   * @returns all of the configuration data blocks
   */
  async configurationServiceEnvironments(
    deploys: Deploy[],
    fullYamlSupport: boolean
  ): Promise<Array<Record<string, any>>> {
    const configurationDeploys = deploys.filter((deploy) => {
      const serviceType: DeployTypes = fullYamlSupport ? deploy.deployable?.type : deploy.service?.type;

      return serviceType === DeployTypes.CONFIGURATION;
    });

    if (!this?.db?.models) this.db = new Database();

    const configurations = await Promise.all(
      configurationDeploys.map((deploy) => {
        if (deploy.serviceId != null) {
          return this.db.models.Configuration.query()
            .where('serviceId', deploy.serviceId)
            .where('key', deploy.branchName)
            .first();
        }
      })
    );

    return _.compact(configurations.map((configuration) => (configuration ? configuration.data : null)));
  }

  /**
   * Parses acompiled json string back int a k/v record
   * @param compiledTemplate the string to compile back into a k/v
   */
  parseTemplateData(compiledTemplate: string): Record<string, any> {
    return JSON.parse(compiledTemplate.replace(HYPHEN_REPLACEMENT_REGEX, '-'));
  }

  /**
   * Takes in an environment represented as a string, and a list of token replaceable values
   * that are available in this environment, and returns back a compiled string with the token
   * values replaced with real values
   * @param envString The environment represented as a string
   * @param availableEnv A k/v map that represents the possible token / value pairs that can be replaced
   */
  async compileEnv(
    envString: Record<string, any>,
    availableEnv: Record<string, string>,
    useDefaultUUID: boolean,
    namespace: string
  ) {
    const str = JSON.stringify(envString || '').replace(/-/g, HYPHEN_REPLACEMENT);
    return await this.compileEnvironmentWithAvailableEnvironment(str, availableEnv, useDefaultUUID, namespace);
  }

  /**
   * Takes in an environment, defined as a string, and a mapping of key/value pairs, and
   * interpolates any variables in the environment string with real values
   * @param environment a string representing the environment variables for our build
   * @param availableEnv the environment variables we can use to replace any variables in the string
   */
  async compileEnvironmentWithAvailableEnvironment(
    environment: string,
    availableEnv: Record<string, any>,
    useDefaultUUID: boolean,
    namespace: string
  ) {
    return await this.customRender(environment, availableEnv, useDefaultUUID, namespace);
  }

  buildHostname({
    host,
    suffix,
    namespace,
    rest,
  }: {
    host: string;
    suffix: string;
    namespace: string;
    rest: string;
  }): string {
    return `${host}${suffix || ''}.${namespace}.svc.cluster.local${rest || ''}`;
  }

  /**
   * Takes in a template string and a data object and renders the template with the data
   * For templates that contain a given string, we replace it with the default value and suffix from the global_config table
   * E.g. {{my______service______db_internalHostname}} will be replaced with my-service-db-${defaultUUID}
   * @param template the template string to render
   * @param data the data to render the template with
   * @returns the rendered template
   */
  async customRender(template, data, useDefaultUUID = true, namespace: string) {
    // Convert any remaining double-curly placeholders into triple-curly ones to render unescaped HTML
    template = template.replace(/{{{?([^{}]*?)}}}?/g, '{{{$1}}}');

    /**
     * Regex pattern to parse strings with triple curly braces (`{{{ }}}`), optional suffixes,
     * and delimiters like `:` (colon) or `/` (forward slash).
     *
     * Capture Groups:
     * 1. Content inside triple curly braces (e.g., `backend-cache_internalHostname`).
     * 2. Optional text between closing braces (`}}}`) and the first delimiter (`:` or `/`).
     * 3. Delimiter (`:` or `/`) along with everything after it (e.g., port numbers, paths, or escaped characters).
     *
     * Structure:
     * {{{([^{}]+)}}}    - Group 1: Captures content inside triple curly braces.
     * ([^:\/]*?)        - Group 2: Captures text after closing braces but before the first delimiter (`:` or `/`).
     * ((?::|\/)         - Group 3: Captures the delimiter (`:` or `/`) and starts capturing everything after it.
     *   [^"\\]*         - Matches zero or more characters that are not double quotes (`"`) or backslashes (`\`).
     *   (?:\\.[^"\\]*)* - Handles escaped characters like `\0` or `\n`.
     * )?                - Makes Group 3 optional (no delimiter is allowed).
     * (?=")             - Positive lookahead to ensure the match stops before a closing double quote (`"`).
     */
    // eslint-disable-next-line no-useless-escape
    const regex = /{{{([^{}]+)}}}([^:\/]*?)((?::|\/)[^"\\]*(?:\\.[^"\\]*)*)?(?=")/g;

    const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
    const defaultUuid = useDefaultUUID ? globalConfig.lifecycleDefaults.defaultUUID : NO_DEFAULT_ENV_UUID;
    const staticEnvNamespace = useDefaultUUID
      ? await this.db.services.BuildService.getNamespace({ uuid: defaultUuid })
      : 'no-namespace';
    const templateMatches = template.matchAll(regex);
    for (const match of templateMatches) {
      const fullMatch = match[0];
      const captureGroup = match[1];
      const suffix = match[2];
      const rest = match[3];
      if (data[captureGroup] !== undefined) {
        // this replace only for internalHostname to support namespaced deployments.
        // we have to figure out if its an active service to decide on what namespace to use
        // hackity hack, if data[captureGroup] does not contain the buildUUID, then its an inactive service!!!
        // inactive service default to static env so find that namespace to render in the value.
        const nsForDeploy =
          data[captureGroup] && typeof data[captureGroup] === 'string' && data[captureGroup].includes(data['buildUUID'])
            ? namespace
            : staticEnvNamespace;
        if (captureGroup.includes('_internalHostname')) {
          template = template.replace(
            fullMatch,
            this.buildHostname({ host: data[captureGroup], suffix, rest, namespace: nsForDeploy })
          );
        }
        continue;
      }
      if (captureGroup.endsWith('_UUID')) {
        template = template.replace(fullMatch, defaultUuid);
        continue;
      }
      if (captureGroup.includes('_internalHostname')) {
        const serviceToUpdate = captureGroup.replace(HYPHEN_REPLACEMENT_REGEX, '-');
        const defaultedInternalHostname = serviceToUpdate.replace(/_internalHostname$/, `-${defaultUuid}`);
        template = template.replace(
          fullMatch,
          this.buildHostname({ host: defaultedInternalHostname, namespace: staticEnvNamespace, suffix, rest })
        );
      }
      if (captureGroup.includes('_publicUrl')) {
        const serviceToUpdate = captureGroup.replace(HYPHEN_REPLACEMENT_REGEX, '-');
        const defaultedPublicUrl = serviceToUpdate.replace(
          /_publicUrl$/,
          `-${globalConfig.lifecycleDefaults.defaultPublicUrl}`
        );
        logger.debug(
          `[BUILD ${data['buildUUID']}] The publicUrl for ${serviceToUpdate} has been defaulted to ${defaultedPublicUrl} using the global_config table`
        );
        template = template.replace(fullMatch, defaultedPublicUrl);
      }
    }

    return mustache.render(template, data);
  }

  public abstract resolve(
    // eslint-disable-next-line no-unused-vars
    build: Build,
    // eslint-disable-next-line no-unused-vars
    webhook?: any
  ): Promise<Record<string, any>>;
}
