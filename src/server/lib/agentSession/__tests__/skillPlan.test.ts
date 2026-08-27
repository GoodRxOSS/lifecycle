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

import { resolveAgentSessionSkillPlan } from '../skillPlan';

describe('resolveAgentSessionSkillPlan', () => {
  it('normalizes sources, preserves precedence, and removes equivalent later entries', () => {
    const result = resolveAgentSessionSkillPlan({
      basePlan: {
        version: 1,
        skills: [
          {
            repo: 'goodrx/base-skills',
            repoUrl: 'https://github.com/goodrx/base-skills.git',
            branch: 'main',
            path: 'skills/base',
            source: 'environment',
          },
        ],
      },
      environmentSkillRefs: [
        {
          repo: 'https://github.com/GoodRx/skills.git',
          branch: ' main ',
          path: './skills\\review/',
        },
      ],
      services: [
        {
          name: 'api',
          devConfig: {
            agentSession: {
              skills: [
                { repo: 'goodrx/skills', branch: 'main', path: 'skills/review' },
                { repo: 'goodrx/service-skills.git', branch: 'release', path: '/skills/api/' },
              ],
            },
          },
        },
      ],
    });

    expect(result).toEqual({
      version: 1,
      skills: [
        {
          repo: 'goodrx/base-skills',
          repoUrl: 'https://github.com/goodrx/base-skills.git',
          branch: 'main',
          path: 'skills/base',
          source: 'environment',
        },
        {
          repo: 'GoodRx/skills',
          repoUrl: 'https://github.com/GoodRx/skills.git',
          branch: 'main',
          path: 'skills/review',
          source: 'environment',
        },
        {
          repo: 'goodrx/service-skills',
          repoUrl: 'https://github.com/goodrx/service-skills.git',
          branch: 'release',
          path: 'skills/api',
          source: 'service',
          serviceName: 'api',
        },
      ],
    });
  });

  it.each([
    ['a blank repository', { repo: '   ', branch: 'main', path: 'skills/review' }, 'Skill repo is required'],
    ['a repository without an owner', { repo: 'skills', branch: 'main', path: 'skills/review' }, 'Invalid skill repo'],
    ['a blank normalized path', { repo: 'goodrx/skills', branch: 'main', path: './//' }, 'Skill path is required'],
  ])('rejects %s', (_label, skillRef, expectedMessage) => {
    expect(() => resolveAgentSessionSkillPlan({ environmentSkillRefs: [skillRef] })).toThrow(expectedMessage);
  });
});
