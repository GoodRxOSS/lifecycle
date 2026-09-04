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

import { getLogger } from './logger';
import { BuildKind, CommentParser } from 'shared/constants';
import { compact, flatten, set } from 'lodash';
import type Service from 'server/services/_service';
import type { Build, PullRequest } from 'server/models';

/**
 * Only build and deploy status transitions normally rebuild the Mission Control comment, so a
 * config change that queues no redeploy would leave it stale — and editing that stale comment
 * would then reapply the old state. Callers decide when this applies, since the environments
 * patch aggregates its sub-calls while the per-build routes refresh per call.
 */
export async function refreshMissionControlComment(
  service: Service,
  build: Build,
  pullRequest: PullRequest | null | undefined = build?.pullRequest
): Promise<void> {
  if (!pullRequest || build?.kind === BuildKind.SANDBOX) {
    return;
  }

  try {
    const { db, redis, redlock, queueManager } = service;
    const activityStream =
      db.services?.ActivityStream ??
      new (await import('server/services/activityStream')).default(db, redis, redlock, queueManager);

    // queue:true enqueues by pullRequest.id and returns before `repository` is read; the queued worker re-fetches its own graph.
    await activityStream.updatePullRequestActivityStream(build, [], pullRequest, null, true, true, null, true);
  } catch (error) {
    getLogger().warn({ error }, 'Comment: mission control refresh failed after non-redeploy config change');
  }
}

// Matches the list-item line only; quoted lines are not checkboxes on GitHub.
const REDEPLOY_ON_PUSH_LINE = /^[ \t]*[-*+] \[([ xX])\] Redeploy on pushes to default branches[ \t]*\r?$/m;

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

  /** Undefined means the line is absent, which callers must not persist as false. */
  public static parseRedeployOnPushes(comment: string): boolean | undefined {
    const match = REDEPLOY_ON_PUSH_LINE.exec(comment ?? '');
    if (!match) {
      return undefined;
    }
    return match[1].toLowerCase() === 'x';
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
      .map((line) => line.trim());
    const envLines = lines.filter((line) => {
      return line.startsWith('ENV:');
    });
    const obj = {};
    envLines.forEach((line) => {
      getLogger().debug(`Parsing environment override line=${line}`);
      const match = line.match(/ENV:([^:]*):(.*)/m);
      const key = match[1].trim();
      const value = match[2].trim();
      set(obj, key, value);
    });
    return obj;
  }
}
