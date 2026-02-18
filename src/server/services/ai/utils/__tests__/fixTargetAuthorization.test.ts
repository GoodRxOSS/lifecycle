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

import { authorizeToolForFixTarget } from '../fixTargetAuthorization';

describe('authorizeToolForFixTarget', () => {
  it('blocks file writes when selected fix target is PR label-only', () => {
    const decision = authorizeToolForFixTarget(
      {
        serviceName: 'Environment',
        suggestedFix: 'Add the lifecycle-deploy! label to the PR in GitHub.',
      },
      {
        name: 'update_file',
        description: 'Update repository file',
        category: 'github',
        safetyLevel: 'dangerous',
        args: {
          file_path: 'lifecycle.yaml',
        },
      }
    );

    expect(decision.allowed).toBe(false);
  });

  it('allows file writes only for selected target files', () => {
    const allowDecision = authorizeToolForFixTarget(
      {
        serviceName: 'lc-test-helm-local',
        suggestedFix: "Change dockerfilePath from 'a' to 'b' in lifecycle.yaml",
        filePath: 'lifecycle.yaml',
      },
      {
        name: 'update_file',
        description: 'Update repository file',
        category: 'github',
        safetyLevel: 'dangerous',
        args: {
          file_path: 'lifecycle.yaml',
        },
      }
    );

    const denyDecision = authorizeToolForFixTarget(
      {
        serviceName: 'lc-test-helm-local',
        suggestedFix: "Change dockerfilePath from 'a' to 'b' in lifecycle.yaml",
        filePath: 'lifecycle.yaml',
      },
      {
        name: 'update_file',
        description: 'Update repository file',
        category: 'github',
        safetyLevel: 'dangerous',
        args: {
          file_path: 'sysops/dockerfiles/app.dockerfile',
        },
      }
    );

    expect(allowDecision.allowed).toBe(true);
    expect(denyDecision.allowed).toBe(false);
  });

  it('allows a PR label tool when target is label fix', () => {
    const decision = authorizeToolForFixTarget(
      {
        serviceName: 'Environment',
        suggestedFix: 'Add the lifecycle-deploy! label to the PR in GitHub.',
      },
      {
        name: 'mcp__github__add_pr_label',
        description: 'Add label to pull request',
        category: 'mcp',
        safetyLevel: 'cautious',
        args: {
          label: 'lifecycle-deploy!',
        },
      }
    );

    expect(decision.allowed).toBe(true);
  });
});
