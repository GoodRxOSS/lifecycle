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

import Build from 'server/models/Build';
import Conversation from 'server/models/Conversation';

export interface FeedbackContext {
  repo: string;
  prNumber?: number;
}

export async function resolveFeedbackContext(buildUuid: string): Promise<FeedbackContext> {
  const existingConversation = await Conversation.query().findById(buildUuid).select('repo');
  const build = await Build.query()
    .findOne({ uuid: buildUuid })
    .withGraphFetched('pullRequest')
    .modifyGraph('pullRequest', (builder) => {
      builder.select('id', 'fullName', 'pullRequestNumber');
    });

  const buildRepo = build?.pullRequest?.fullName?.trim();
  const buildPrNumber = build?.pullRequest?.pullRequestNumber;

  if (buildRepo) {
    return {
      repo: buildRepo,
      ...(buildPrNumber != null ? { prNumber: buildPrNumber } : {}),
    };
  }

  if (existingConversation?.repo) {
    return {
      repo: existingConversation.repo,
    };
  }

  return {
    repo: '',
  };
}
