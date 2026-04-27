import swaggerJSDoc from 'swagger-jsdoc';
import { openApiSpecificationForV2Api } from './openApiSpec';

const swaggerSpec = swaggerJSDoc(openApiSpecificationForV2Api) as any;
const schemas = swaggerSpec.components.schemas;

function getJsonErrorSchema(path: string, method: string, status: string) {
  return swaggerSpec.paths[path][method].responses[status].content['application/json'].schema;
}

describe('OpenAPI v2 agent session contract', () => {
  it('documents canonical run events with public context and a version', () => {
    const eventSchema = schemas.AgentRunMessagePartEvent;

    expect(eventSchema.required).toEqual(
      expect.arrayContaining(['id', 'runId', 'threadId', 'sessionId', 'sequence', 'eventType', 'version', 'payload'])
    );
    expect(eventSchema.properties.threadId).toEqual({ type: 'string', description: 'Public thread UUID.' });
    expect(eventSchema.properties.sessionId).toEqual({ type: 'string', description: 'Public session UUID.' });
    expect(eventSchema.properties.version).toEqual({ type: 'integer', enum: [1] });
  });

  it('keeps canonical reference message parts aligned with runtime validation', () => {
    const messagePartSchema = schemas.CanonicalAgentMessagePart;
    const fileRefSchema = messagePartSchema.oneOf.find((entry: any) => entry.properties.type.enum[0] === 'file_ref');
    const sourceRefSchema = messagePartSchema.oneOf.find(
      (entry: any) => entry.properties.type.enum[0] === 'source_ref'
    );

    expect(fileRefSchema.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ['path'], properties: { path: { type: 'string', minLength: 1 } } }),
        expect.objectContaining({ required: ['url'], properties: { url: { type: 'string', minLength: 1 } } }),
      ])
    );
    expect(sourceRefSchema.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ['url'], properties: { url: { type: 'string', minLength: 1 } } }),
        expect.objectContaining({ required: ['title'], properties: { title: { type: 'string', minLength: 1 } } }),
      ])
    );
  });

  it('removes migration bridges without preserving UI-shaped success contracts', () => {
    expect(swaggerSpec.paths['/api/v2/ai/agent/threads/{threadId}/conversation']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/runs/{runId}/stream']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/pending-actions/{actionId}/approve']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/pending-actions/{actionId}/deny']).toBeUndefined();
    expect(schemas.AgentUIMessage).toBeUndefined();
    expect(schemas.AgentUIMessagePart).toBeUndefined();
    expect(schemas.AgentUIMessageMetadata).toBeUndefined();
  });

  it('documents JSON error responses for changed canonical endpoints', () => {
    expect(getJsonErrorSchema('/api/v2/ai/agent/threads/{threadId}/messages', 'get', '400')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
    expect(getJsonErrorSchema('/api/v2/ai/agent/runs/{runId}/events/stream', 'get', '400')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
    expect(getJsonErrorSchema('/api/v2/ai/config/agent-session', 'get', '401')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
    expect(getJsonErrorSchema('/api/v2/ai/config/agent-session/runtime', 'put', '401')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
  });
});
