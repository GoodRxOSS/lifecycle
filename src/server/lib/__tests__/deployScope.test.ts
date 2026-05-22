import { normalizeRepositoryId, scopedDeployableNames } from '../deployScope';

describe('deploy scope helpers', () => {
  test('preserves null repository IDs instead of coercing them to zero', () => {
    expect(normalizeRepositoryId(null)).toBeNull();
    expect(normalizeRepositoryId(undefined)).toBeNull();
    expect(normalizeRepositoryId('')).toBeNull();
    expect(normalizeRepositoryId(123)).toBe(123);
    expect(normalizeRepositoryId('123')).toBe(123);
  });

  test('includes YAML-only Docker dependencies for a scoped repository deploy', () => {
    const scopedNames = scopedDeployableNames(
      [
        { name: 'sponsored-benefits', repositoryId: 1154960313 },
        {
          name: 'sbs-localstack',
          repositoryId: null,
          dependsOnDeployableName: 'sponsored-benefits',
        },
        { name: 'unrelated-localstack', repositoryId: null, dependsOnDeployableName: 'other-service' },
        { name: 'external-partners', repositoryId: 932333620 },
      ],
      1154960313
    );

    expect(Array.from(scopedNames).sort()).toEqual(['sbs-localstack', 'sponsored-benefits']);
  });

  test('includes explicit deployment dependencies for a scoped repository deploy', () => {
    const scopedNames = scopedDeployableNames(
      [
        { name: 'api', repositoryId: 1, deploymentDependsOn: ['db', 'localstack'] },
        { name: 'db', repositoryId: null },
        { name: 'localstack', repositoryId: null },
        { name: 'worker', repositoryId: 2 },
      ],
      1
    );

    expect(Array.from(scopedNames).sort()).toEqual(['api', 'db', 'localstack']);
  });
});
