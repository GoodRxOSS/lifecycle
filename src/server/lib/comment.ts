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

import { getLogger } from './logger/index';
import { CommentParser } from 'shared/constants';
import { compact, flatten, set } from 'lodash';

export class CommentHelper {
  public static parseServiceBranches(comment: string): Array<{
    active: boolean;
    serviceName: string;
    branchOrExternalUrl: string;
  }> {
    const textToParse = comment.split(CommentParser.HEADER)[1].split(CommentParser.FOOTER)[0];
    const lines = textToParse
      .match(/[^\r\n]+/g) // Match by newline
      .map((line) => line.replace(/ /g, '')); // Remove all whitespace
    const serviceBranches = lines.map((line) => {
      if (line.startsWith('-')) {
        const [checkbox, serviceName, branchOrExternalUrl] = line.match(/\s?(\[x?\])\s?(.*):\s?(.*)/).slice(1);
        const active = checkbox === '[x]';
        return {
          active,
          serviceName,
          branchOrExternalUrl,
        };
      }
    });
    return compact(flatten(serviceBranches));
  }

  public static parseRedeployOnPushes(comment: string): boolean {
    return comment.match(/\[x\] Redeploy on pushes to default branches/g) != null;
  }

  public static parseVanityUrl(comment: string): string {
    const textToParse = comment.split(CommentParser.HEADER)[1].split(CommentParser.FOOTER)[0];
    const lines = textToParse
      .match(/[^\r\n]+/g) // Match by newline
      .map((line) => line.replace(/ /g, '')); // Remove all whitespace
    const urlLine = lines.find((line) => {
      return line.startsWith('url:');
    });
    if (urlLine) {
      return urlLine.split(':')[1];
    } else {
      return null;
    }
  }

  public static parseEnvironmentOverrides(comment: string) {
    const textToParse = comment.split(CommentParser.HEADER)[1].split(CommentParser.FOOTER)[0];
    const lines = textToParse
      .match(/[^\r\n]+/g) // Match by newline
      .map((line) => line.replace(/ /g, '')); // Remove all whitespace
    const envLines = lines.filter((line) => {
      return line.startsWith('ENV:');
    });
    const obj = {};
    envLines.forEach((line) => {
      getLogger().debug(`Parsing environment override line=${line}`);
      const match = line.match(/ENV:([^:]*):(.*)/m);
      const key = match[1];
      const value = match[2];
      set(obj, key, value);
    });
    return obj;
  }
}
