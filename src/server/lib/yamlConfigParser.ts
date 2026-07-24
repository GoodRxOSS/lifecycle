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

import yaml from 'js-yaml';
import * as github from 'server/lib/github';
import { LifecycleConfig } from 'server/models/yaml/Config';
import { LifecycleError } from './errors';

export class ParsingError extends LifecycleError {
  constructor(msg: string, uuid: string = null, service: string = null) {
    super(uuid, service, msg);
  }
}

export class EmptyFileError extends LifecycleError {
  constructor(msg: string, uuid: string = null, service: string = null) {
    super(uuid, service, msg);
  }
}

export class YamlConfigParser {
  constructor() {}

  /**
   * Parse Lifecycle YAML file content into a data structure
   * @param githubInstallationId Github App Installation ID for permission
   * @param githubRepoFullName  Github Repo Fullname
   * @param githubPullRequestNumber Github Pull Request Number (Not the global UUID)
   * @returns Lifecycle Config
   */
  public async getRawYamlConfigFromPullRequest(githubRepoFullName: string, githubPullRequestNumber: number) {
    return github.getYamlFileContentFromPullRequest(githubRepoFullName, githubPullRequestNumber);
  }

  /**
   * Parse Lifecycle YAML file content into a data structure
   * @param githubInstallationId Github App Installation ID for permission
   * @param githubRepoFullName  Github Repo Fullname
   * @param branchName Github Pull Request Number (Not the global UUID)
   * @returns Lifecycle Config
   */
  public async getRawYamlConfigFromBranch(githubRepoFullName: string, branchName: string): Promise<string> {
    return github.getYamlFileContentFromBranch(githubRepoFullName, branchName);
  }

  /**
   * Parse Lifecycle YAML file content into a data structure
   * @param yamlContent Lifecycle YAML file content
   * @returns Lifecycle Config
   */
  public parseYamlConfigFromString(yamlContent: string): LifecycleConfig {
    let config: unknown = null;

    if (yamlContent != null) {
      try {
        config = yaml.load(yamlContent);
      } catch (error) {
        throw new ParsingError(error);
      }
    } else {
      throw new EmptyFileError('Config file is empty.');
    }

    return config as LifecycleConfig;
  }

  /**
   * Parse Lifecycle YAML file content into a data structure
   * @param githubInstallationId Github App Installation ID for permission
   * @param githubRepoFullName  Github Repo Fullname
   * @param githubPullRequestNumber Github Pull Request Number (Not the global UUID)
   * @returns Lifecycle Config
   */
  public async parseYamlConfigFromPullRequest(
    githubRepoFullName: string,
    githubPullRequestNumber: number
  ): Promise<LifecycleConfig> {
    return this.parseYamlConfigFromString(
      (await github.getYamlFileContentFromPullRequest(githubRepoFullName, githubPullRequestNumber)) as string
    );
  }

  /**
   * Parse Lifecycle YAML file content into a data structure
   * @param githubInstallationId Github App Installation ID for permission
   * @param githubRepoFullName  Github Repo Fullname
   * @param githubPullRequestNumber Github Pull Request Number (Not the global UUID)
   * @returns Lifecycle Config
   */
  public async parseYamlConfigFromBranch(
    githubRepoFullName: string,
    githubRepoBranchName: string
  ): Promise<LifecycleConfig> {
    return this.parseYamlConfigFromString(
      await github.getYamlFileContentFromBranch(githubRepoFullName, githubRepoBranchName)
    );
  }
}
