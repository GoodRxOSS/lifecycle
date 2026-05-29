import AgentSession from 'server/models/AgentSession';

// Load an AgentSession scoped to the requesting user; throws if not found.
export async function getOwnedSession(sessionUuid: string, userId: string): Promise<AgentSession> {
  const session = await AgentSession.query().findOne({ uuid: sessionUuid, userId });
  if (!session) {
    throw new Error('Agent session not found');
  }

  return session;
}
