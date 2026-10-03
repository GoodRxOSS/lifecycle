import swaggerJSDoc from 'swagger-jsdoc';
import { openApiSpecificationForV2Api } from './openApiSpec';

const spec = swaggerJSDoc(openApiSpecificationForV2Api) as any;
const schemas = spec.components.schemas;

describe('Admin environment analytics OpenAPI contract', () => {
  it.each([
    ['environments', 'getEnvironmentAnalytics', 'GetEnvironmentAnalyticsSuccessResponse'],
    ['inventory', 'getInventoryAnalytics', 'GetInventoryAnalyticsSuccessResponse'],
    ['options', 'getAnalyticsOptions', 'GetAnalyticsOptionsSuccessResponse'],
    ['environments/records', 'getEnvironmentAnalyticsRecords', 'GetEnvironmentAnalyticsRecordsSuccessResponse'],
  ])('documents %s with a concrete generated response and session authentication', (path, operationId, response) => {
    const operation = spec.paths[`/api/v2/admin/analytics/${path}`].get;
    expect(operation.operationId).toBe(operationId);
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: `#/components/schemas/${response}`,
    });
    const dataSchema = schemas[response].allOf[1].properties.data.$ref.split('/').at(-1);
    expect(schemas[dataSchema]).toBeDefined();
    expect(operation.security ?? spec.security).toEqual([{ BearerAuth: [] }]);
    expect(operation.responses['403'].description).toContain('Administrator');
  });

  it('preserves current-only phases and nullable history availability metadata', () => {
    const operation = spec.paths['/api/v2/admin/analytics/environments/records'].get;
    expect(operation.parameters.find((param: any) => param.name === 'phase').description).toContain('current');
    expect(schemas.EnvironmentAnalyticsRecord.properties.phase.enum).toEqual([
      'ready',
      'deployed_not_ready',
      'in_progress',
      'paused',
      'failed',
      'tearing_down',
      'torn_down',
    ]);
    expect(schemas.EnvironmentAnalyticsRecord.required).toEqual(
      expect.arrayContaining(['resourceAvailable', 'deletedAt', 'repositoryAmbiguous', 'pullRequest'])
    );
    expect(schemas.EnvironmentAnalyticsRecord.properties.pullRequest.nullable).toBe(true);
    expect(schemas.EnvironmentAnalyticsRecords.properties.range.nullable).toBe(true);
    expect(schemas.EnvironmentAnalyticsPagination.properties.limit.maximum).toBe(100);
  });

  it('models calendar bounds, optional comparison and inapplicable PR values honestly', () => {
    const operation = spec.paths['/api/v2/admin/analytics/environments'].get;
    expect(operation.parameters.find((param: any) => param.name === 'compare').schema.default).toBe(true);
    expect(operation.parameters.find((param: any) => param.name === 'rankBy').schema.enum).toEqual([
      'first_seen',
      'observed_prs',
      'pr_coverage',
    ]);
    expect(schemas.AnalyticsRange.properties.calendarDays.maximum).toBe(365);
    expect(schemas.AnalyticsRange.properties.previous.nullable).toBe(true);
    expect(schemas.EnvironmentAnalyticsTotals.properties.observedPullRequests.nullable).toBe(true);
    expect(schemas.EnvironmentAnalyticsBucket.properties.previousFirstSeenEnvironments.nullable).toBe(true);
    expect(schemas.EnvironmentAnalyticsRetention.properties.collectionStartedAt.description).toContain('Unknown');
  });

  it('retains installation-aware options and bounded output metadata', () => {
    expect(schemas.AnalyticsRepositoryOption.required).toEqual(
      expect.arrayContaining(['repositoryId', 'githubInstallationId', 'githubRepositoryId', 'deletedAt'])
    );
    expect(schemas.AnalyticsOptions.properties.truncated.required).toEqual([
      'repositories',
      'organizations',
      'environmentAuthors',
    ]);
    expect(schemas.EnvironmentAnalytics.required).toEqual(expect.arrayContaining(['rankingTotal', 'rankingTruncated']));
    expect(schemas.InventoryAnalytics.required).toEqual(
      expect.arrayContaining(['repositoryTotal', 'repositoriesTruncated', 'truncated'])
    );
  });
});
