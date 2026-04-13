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

import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';

function normalizeTitle(title?: string | null): string | null {
  const trimmed = title?.trim();
  return trimmed ? trimmed : null;
}

export default class AgentThreadService {
  static async getOwnedSession(sessionUuid: string, userId: string): Promise<AgentSession> {
    const session = await AgentSession.query().findOne({ uuid: sessionUuid, userId });
    if (!session) {
      throw new Error('Agent session not found');
    }

    return session;
  }

  static async getOwnedThread(threadUuid: string, userId: string): Promise<AgentThread> {
    const thread = await AgentThread.query()
      .alias('thread')
      .joinRelated('session')
      .where('thread.uuid', threadUuid)
      .where('session.userId', userId)
      .select('thread.*')
      .first();

    if (!thread) {
      throw new Error('Agent thread not found');
    }

    return thread;
  }

  static async getOwnedThreadWithSession(
    threadUuid: string,
    userId: string
  ): Promise<{ thread: AgentThread; session: AgentSession }> {
    const thread = await AgentThread.query()
      .alias('thread')
      .joinRelated('session')
      .where('thread.uuid', threadUuid)
      .where('session.userId', userId)
      .select('thread.*', 'session.uuid as sessionUuid')
      .first();

    if (!thread) {
      throw new Error('Agent thread not found');
    }

    const session = await AgentSession.query().findById(thread.sessionId);
    if (!session || session.userId !== userId) {
      throw new Error('Agent session not found');
    }

    return { thread, session };
  }

  static async getDefaultThreadForSession(sessionUuid: string, userId: string): Promise<AgentThread> {
    const session = await this.getOwnedSession(sessionUuid, userId);
    const existing = await AgentThread.query().findOne({
      sessionId: session.id,
      isDefault: true,
      archivedAt: null,
    });

    if (existing) {
      return existing;
    }

    try {
      return await AgentThread.query().insertAndFetch({
        sessionId: session.id,
        title: 'Default thread',
        isDefault: true,
        metadata: {
          sessionUuid: session.uuid,
        },
      } as Partial<AgentThread>);
    } catch (error) {
      const retried = await AgentThread.query().findOne({
        sessionId: session.id,
        isDefault: true,
        archivedAt: null,
      });
      if (!retried) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create default thread: ${message}`);
      }
      return retried;
    }
  }

  static async listThreadsForSession(sessionUuid: string, userId: string): Promise<AgentThread[]> {
    const session = await this.getOwnedSession(sessionUuid, userId);
    await this.getDefaultThreadForSession(sessionUuid, userId);

    return AgentThread.query()
      .where({ sessionId: session.id })
      .whereNull('archivedAt')
      .orderBy('isDefault', 'desc')
      .orderBy('createdAt', 'asc');
  }

  static async createThread(sessionUuid: string, userId: string, title?: string | null): Promise<AgentThread> {
    const session = await this.getOwnedSession(sessionUuid, userId);

    return AgentThread.query().insertAndFetch({
      sessionId: session.id,
      title: normalizeTitle(title),
      isDefault: false,
      metadata: {
        sessionUuid: session.uuid,
      },
    } as Partial<AgentThread>);
  }

  static serializeThread(thread: AgentThread, sessionUuid?: string) {
    return {
      id: thread.uuid,
      sessionId: sessionUuid,
      title: thread.title,
      isDefault: thread.isDefault,
      archivedAt: thread.archivedAt,
      lastRunAt: thread.lastRunAt,
      metadata: thread.metadata || {},
      createdAt: thread.createdAt || null,
      updatedAt: thread.updatedAt || null,
    };
  }
}
