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

jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/models/AgentPrewarm');
jest.mock('server/models/AgentSession');
jest.mock('server/models/Build');
jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfig: jest.fn(),
}));
jest.mock('server/lib/agentSession/pvcFactory', () => ({
  createAgentPvc: jest.fn(),
  deleteAgentPvc: jest.fn(),
}));
jest.mock('../agentSessionCandidates', () => ({
  resolveAgentSessionServiceCandidates: jest.fn(),
  resolveRequestedAgentSessionServices: jest.fn(),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  })),
  extractContextForQueue: jest.fn(() => ({ requestId: 'req-123' })),
}));

import AgentPrewarm from 'server/models/AgentPrewarm';
import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import { fetchLifecycleConfig } from 'server/models/yaml';
import AgentPrewarmService from 'server/services/agentPrewarm';
import { deleteAgentPvc } from 'server/lib/agentSession/pvcFactory';
import { resolveAgentSessionServiceCandidates, resolveRequestedAgentSessionServices } from '../agentSessionCandidates';

describe('AgentPrewarmService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AgentPrewarm.query as jest.Mock) = jest.fn();
    (AgentSession.query as jest.Mock) = jest.fn();
    (deleteAgentPvc as jest.Mock).mockResolvedValue(undefined);
  });

  describe('canReusePrewarm', () => {
    it('allows requested services that are a subset of the prewarm service list', () => {
      expect(AgentPrewarmService.canReusePrewarm(['web', 'api'], ['web'])).toBe(true);
    });

    it('rejects requested services that are not fully covered by the prewarm service list', () => {
      expect(AgentPrewarmService.canReusePrewarm(['web'], ['web', 'api'])).toBe(false);
    });
  });

  describe('queueBuildPrewarm', () => {
    it('does not enqueue when a matching active prewarm already exists', async () => {
      const queueAdd = jest.fn();
      const queueManager = {
        registerQueue: jest.fn().mockReturnValue({ add: queueAdd }),
      };
      const service = new AgentPrewarmService({} as any, {} as any, {} as any, queueManager as any);
      jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue({
        buildUuid: 'build-123',
        namespace: 'env-sample',
        repo: 'example-org/example-repo',
        repoUrl: 'https://github.com/example-org/example-repo.git',
        branch: 'sample-branch',
        revision: 'sha-123',
        configuredServiceNames: ['api', 'web'],
        services: [],
      });
      (AgentPrewarm.query as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([
          {
            revision: 'sha-123',
            services: ['web', 'api'],
            status: 'ready',
          },
        ]),
      });

      await expect(service.queueBuildPrewarm('build-123')).resolves.toBe(false);
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('enqueues when no active prewarm matches the configured services', async () => {
      const queueAdd = jest.fn().mockResolvedValue(undefined);
      const queueManager = {
        registerQueue: jest.fn().mockReturnValue({ add: queueAdd }),
      };
      const service = new AgentPrewarmService({} as any, {} as any, {} as any, queueManager as any);
      jest.spyOn(service as any, 'resolveBuildPrewarmPlan').mockResolvedValue({
        buildUuid: 'build-123',
        namespace: 'env-sample',
        repo: 'example-org/example-repo',
        repoUrl: 'https://github.com/example-org/example-repo.git',
        branch: 'sample-branch',
        revision: 'sha-123',
        configuredServiceNames: ['api', 'web'],
        services: [],
      });
      (AgentPrewarm.query as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([]),
      });

      await expect(service.queueBuildPrewarm('build-123')).resolves.toBe(true);
      expect(queueAdd).toHaveBeenCalledWith(
        'prewarm',
        expect.objectContaining({
          buildUuid: 'build-123',
          requestId: 'req-123',
        }),
        {
          jobId: 'agent-prewarm:build-123:sha-123:api,web',
        }
      );
    });
  });

  describe('resolveBuildPrewarmPlan', () => {
    it('uses pullRequest.latestCommit instead of the synthetic build sha for revision pinning', async () => {
      const queueManager = {
        registerQueue: jest.fn().mockReturnValue({ add: jest.fn() }),
      };
      const service = new AgentPrewarmService({} as any, {} as any, {} as any, queueManager as any);
      const build = {
        kind: 'environment',
        namespace: 'env-sample',
        sha: '1b9337',
        pullRequest: {
          fullName: 'example-org/example-repo',
          branchName: 'sample-branch',
          latestCommit: '0123456789abcdef0123456789abcdef01234567',
        },
        deploys: [],
      };

      (Build.query as jest.Mock).mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue(build),
        }),
      });
      (fetchLifecycleConfig as jest.Mock).mockResolvedValue({
        environment: {
          agentSession: {
            prewarm: {
              services: ['web'],
            },
          },
        },
      });
      (resolveAgentSessionServiceCandidates as jest.Mock).mockReturnValue([
        { name: 'web', deployId: 1, devConfig: { command: 'pnpm dev' } },
      ]);
      (resolveRequestedAgentSessionServices as jest.Mock).mockReturnValue([
        { name: 'web', deployId: 1, devConfig: { command: 'pnpm dev' } },
      ]);

      const plan = await (service as any).resolveBuildPrewarmPlan('build-123');

      expect(plan?.revision).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(plan?.revision).not.toBe('1b9337');
    });
  });

  describe('getReadyPrewarmByPvc', () => {
    it('only preserves the latest ready prewarm pvc for a build', async () => {
      (AgentPrewarm.query as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([
          {
            uuid: 'prewarm-new',
            pvcName: 'agent-prewarm-pvc-new',
            status: 'ready',
          },
          {
            uuid: 'prewarm-old',
            pvcName: 'agent-prewarm-pvc-old',
            status: 'ready',
          },
        ]),
      });
      const service = new AgentPrewarmService(
        {} as any,
        {} as any,
        {} as any,
        {
          registerQueue: jest.fn().mockReturnValue({ add: jest.fn() }),
        } as any
      );

      await expect(
        service.getReadyPrewarmByPvc({ buildUuid: 'build-123', pvcName: 'agent-prewarm-pvc-old' })
      ).resolves.toBeNull();
      await expect(
        service.getReadyPrewarmByPvc({ buildUuid: 'build-123', pvcName: 'agent-prewarm-pvc-new' })
      ).resolves.toEqual(
        expect.objectContaining({
          uuid: 'prewarm-new',
          pvcName: 'agent-prewarm-pvc-new',
        })
      );
    });
  });

  describe('cleanupSupersededPrewarms', () => {
    it('deletes older prewarm pvcs that are not in use by active sessions', async () => {
      const deleteById = jest.fn().mockResolvedValue(1);
      (AgentPrewarm.query as jest.Mock)
        .mockReturnValueOnce({
          where: jest.fn().mockReturnThis(),
          whereIn: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockResolvedValue([
            { id: 20, uuid: 'prewarm-new', pvcName: 'agent-prewarm-pvc-new', status: 'ready' },
            { id: 10, uuid: 'prewarm-old', pvcName: 'agent-prewarm-pvc-old', status: 'ready' },
          ]),
        })
        .mockReturnValueOnce({
          deleteById,
        });
      (AgentSession.query as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([]),
      });
      const service = new AgentPrewarmService(
        {} as any,
        {} as any,
        {} as any,
        {
          registerQueue: jest.fn().mockReturnValue({ add: jest.fn() }),
        } as any
      );

      await (service as any).cleanupSupersededPrewarms(
        { buildUuid: 'build-123', namespace: 'env-sample' },
        { id: 20, uuid: 'prewarm-new', pvcName: 'agent-prewarm-pvc-new' }
      );

      expect(deleteAgentPvc).toHaveBeenCalledWith('env-sample', 'agent-prewarm-pvc-old');
      expect(deleteById).toHaveBeenCalledWith(10);
    });

    it('keeps older prewarm pvcs that are still in use by active sessions', async () => {
      (AgentPrewarm.query as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([
          { id: 20, uuid: 'prewarm-new', pvcName: 'agent-prewarm-pvc-new', status: 'ready' },
          { id: 10, uuid: 'prewarm-old', pvcName: 'agent-prewarm-pvc-old', status: 'ready' },
        ]),
      });
      (AgentSession.query as jest.Mock).mockReturnValue({
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([
          {
            pvcName: 'agent-prewarm-pvc-old',
            status: 'active',
          },
        ]),
      });
      const service = new AgentPrewarmService(
        {} as any,
        {} as any,
        {} as any,
        {
          registerQueue: jest.fn().mockReturnValue({ add: jest.fn() }),
        } as any
      );

      await (service as any).cleanupSupersededPrewarms(
        { buildUuid: 'build-123', namespace: 'env-sample' },
        { id: 20, uuid: 'prewarm-new', pvcName: 'agent-prewarm-pvc-new' }
      );

      expect(deleteAgentPvc).not.toHaveBeenCalled();
    });
  });
});
