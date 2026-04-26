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

jest.mock('server/models/AgentSession');
jest.mock('server/models/Build');
jest.mock('server/models/Deploy');
jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfig: jest.fn(),
  getDeployingServicesByName: jest.fn(),
}));

import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { fetchLifecycleConfig, getDeployingServicesByName } from 'server/models/yaml';
import {
  buildAgentSessionDynamicSystemPrompt,
  combineAgentSessionAppendSystemPrompt,
  resolveAgentSessionPromptContext,
} from '../systemPrompt';

describe('agent session system prompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
      findById: jest.fn().mockResolvedValue(null),
    });
  });

  it('builds a compact dynamic session context prompt', () => {
    expect(
      buildAgentSessionDynamicSystemPrompt({
        namespace: 'env-sample-123456',
        buildUuid: 'sample-123456',
        skillsAvailable: true,
        toolLines: [
          '- inspect files, services, and git state: workspace.read_file, workspace.exec',
          '- run mutating or networked shell commands that are not direct file edits: workspace.exec_mutation',
        ],
        services: [
          {
            name: 'next-web',
            publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
            workDir: '/workspace/apps/next-web',
          },
        ],
      })
    ).toBe(
      [
        'Session context:',
        '- namespace: env-sample-123456',
        '- buildUuid: sample-123456',
        '- selected services:',
        '  - next-web: publicUrl=https://next-web-sample.lifecycle.dev.example.com, workDir=/workspace/apps/next-web',
        '- equipped skills: use skills.list to discover them and skills.learn to load a skill before using it',
        '- equipped tools:',
        '  - inspect files, services, and git state: workspace.read_file, workspace.exec',
        '  - run mutating or networked shell commands that are not direct file edits: workspace.exec_mutation',
      ].join('\n')
    );
  });

  it('combines the configured and dynamic prompts with spacing', () => {
    expect(
      combineAgentSessionAppendSystemPrompt('Use concise responses.', 'Session context:\n- namespace: env-sample')
    ).toBe('Use concise responses.\n\nSession context:\n- namespace: env-sample');
  });

  it('resolves selected service public URLs and workdirs from deploy and lifecycle config metadata', async () => {
    const buildGraphQuery = {
      withGraphFetched: jest.fn().mockResolvedValue({
        pullRequest: {
          fullName: 'example-org/example-repo',
          branchName: 'feature/sample',
        },
      }),
    };
    (Build.query as jest.Mock) = jest.fn().mockReturnValue({
      findOne: jest.fn().mockReturnValue(buildGraphQuery),
    });

    const deployGraphQuery = {
      withGraphFetched: jest.fn().mockResolvedValue([
        {
          uuid: 'next-web-sample-123456',
          branchName: 'feature/sample',
          publicUrl: 'next-web-sample.lifecycle.dev.example.com',
          deployable: { name: 'next-web' },
          repository: { fullName: 'example-org/example-repo' },
          service: null,
        },
      ]),
    };
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue(deployGraphQuery),
    });

    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({
      services: [{ name: 'next-web', dev: { workDir: '/workspace/apps/next-web' } }],
    });
    (getDeployingServicesByName as jest.Mock).mockReturnValue({
      name: 'next-web',
      dev: { workDir: '/workspace/apps/next-web' },
    });

    await expect(
      resolveAgentSessionPromptContext({
        sessionDbId: 123,
        namespace: 'env-sample-123456',
        buildUuid: 'sample-123456',
      })
    ).resolves.toEqual({
      namespace: 'env-sample-123456',
      buildUuid: 'sample-123456',
      services: [
        {
          name: 'next-web',
          publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
          repo: 'example-org/example-repo',
          branch: 'feature/sample',
          workDir: '/workspace/apps/next-web',
        },
      ],
      skillsAvailable: false,
    });

    expect(fetchLifecycleConfig).toHaveBeenCalledWith('example-org/example-repo', 'feature/sample');
    expect(getDeployingServicesByName).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.any(Array),
      }),
      'next-web'
    );
  });
});
