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
    ['services', 'getManagedServiceRecords', 'GetManagedServiceRecordsSuccessResponse'],
    ['lifetimes/scatter', 'getEnvironmentLifetimeScatter', 'GetEnvironmentLifetimeScatterSuccessResponse'],
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

  it('bounds activity series while preserving installation identity and complete comparison buckets', () => {
    const activity = schemas.EnvironmentActivityBreakdown;
    expect(activity.properties.repositoryLimit.enum).toEqual([5]);
    expect(activity.properties.series.maxItems).toBe(7);
    expect(activity.required).toEqual(expect.arrayContaining(['series', 'repositoryTotal', 'groupedRepositories']));
    expect(schemas.EnvironmentActivityAnalyticsSeries.properties.kind.enum).toEqual([
      'repository',
      'other',
      'unattributed',
    ]);
    expect(schemas.EnvironmentActivityAnalyticsSeries.required).toEqual(
      expect.arrayContaining(['key', 'repositoryId', 'githubInstallationId', 'buckets'])
    );
    expect(schemas.EnvironmentActivityAnalyticsBucket.properties.previousFirstSeenEnvironments.nullable).toBe(true);
    expect(schemas.EnvironmentAnalytics.required).not.toContain('activity');
    expect(schemas.EnvironmentAnalytics.properties.activity.$ref).toBe(
      '#/components/schemas/EnvironmentActivityBreakdown'
    );
    const operation = spec.paths['/api/v2/admin/analytics/environments'].get;
    const breakdown = operation.parameters.find((param: any) => param.name === 'activityBreakdown');
    expect(breakdown.schema.enum).toEqual(['none', 'repositories']);
    expect(breakdown.schema.default).toBe('none');
  });

  it('documents complete bounded lifetime points and preserves distinct current-age bands', () => {
    expect(schemas.EnvironmentLifetimeScatter.properties.pointLimit.enum).toEqual([5000]);
    expect(schemas.EnvironmentLifetimeScatter.properties.state.enum).toEqual(['ready', 'empty', 'over_limit']);
    expect(schemas.EnvironmentLifetimeScatterPoint.required).toEqual(
      expect.arrayContaining([
        'resourceAvailable',
        'method',
        'quality',
        'sampleState',
        'durationHours',
        'measuredUntilAt',
      ])
    );
    const operation = spec.paths['/api/v2/admin/analytics/lifetimes/records'].get;
    expect(operation.parameters.find((param: any) => param.name === 'bin').schema.enum).toEqual(
      expect.arrayContaining(['30d_plus', '30_to_90d', '90_to_180d', '180d_plus'])
    );
  });

  it('documents exact session drilldown and session totals before bounded paging', () => {
    const sessions = spec.paths['/api/v2/admin/analytics/agents/sessions'].get;
    expect(sessions.operationId).toBe('getAgentAnalyticsSessions');
    expect(sessions.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GetAgentAnalyticsSessionsSuccessResponse',
    });
    expect(sessions.security ?? spec.security).toEqual([{ BearerAuth: [] }]);
    expect(sessions.responses['403'].description).toBe('Admin permission required.');
    expect(sessions.parameters.find((param: any) => param.name === 'limit').schema.maximum).toBe(100);
    expect(sessions.parameters.find((param: any) => param.name === 'page').schema.maximum).toBe(10000);
    expect(schemas.AgentAnalyticsSession.required).toEqual(
      expect.arrayContaining([
        'sessionId',
        'runs',
        'repositories',
        'repositoryCount',
        'tokens',
        'reportedCost',
        'estimatedCost',
      ])
    );
    expect(schemas.AgentAnalyticsSession.properties.repositories.maxItems).toBe(5);
    const runs = spec.paths['/api/v2/admin/analytics/agents/runs'].get;
    expect(runs.parameters.find((param: any) => param.name === 'sessionId').schema.format).toBe('uuid');
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

  it('separates unique configured Services, runtime instances, exclusions, and current-only environment counts', () => {
    expect(schemas.InventoryAnalytics.properties.services.$ref).toBe('#/components/schemas/ManagedServiceInventory');
    expect(schemas.ManagedServiceInventory.properties.distinctServices.description).toContain('owning repository');
    expect(schemas.ManagedServiceInventory.required).toEqual(
      expect.arrayContaining(['instances', 'unresolvedIdentityInstances', 'excluded', 'byType'])
    );
    expect(schemas.ManagedServiceInventory.properties.excluded.required).toEqual([
      'externalInstances',
      'buildOnlyInstances',
      'unknownTypeInstances',
    ]);
    expect(schemas.ManagedServiceRecord.properties.type.enum).toEqual(['docker', 'github', 'helm', 'aurora-restore']);
    expect(schemas.ManagedServiceRecord.required).toEqual(
      expect.arrayContaining(['identityResolved', 'sourceGithubRepositoryId', 'serviceId', 'key'])
    );
    expect(schemas.EnvironmentAnalyticsRecord.properties.serviceInstances.nullable).toBe(true);
    expect(schemas.EnvironmentAnalyticsRecord.properties.serviceTypes.nullable).toBe(true);
    const operation = spec.paths['/api/v2/admin/analytics/services'].get;
    expect(operation.description).toContain('Historical date controls are ignored');
    expect(operation.parameters.find((param: any) => param.name === 'limit').schema.maximum).toBe(100);
  });
});
