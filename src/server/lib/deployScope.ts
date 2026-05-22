export interface DeployScopeNode {
  name?: string | null;
  repositoryId?: number | string | null;
  dependsOnDeployableName?: string | null;
  deploymentDependsOn?: string[] | string | null;
}

export function normalizeRepositoryId(repositoryId: number | string | null | undefined): number | null {
  if (repositoryId == null || repositoryId === '') {
    return null;
  }

  const parsed = Number(repositoryId);
  return Number.isFinite(parsed) ? parsed : null;
}

function deploymentDependencyNames(node: DeployScopeNode | undefined): string[] {
  const dependencies = node?.deploymentDependsOn;
  if (!dependencies) {
    return [];
  }

  if (Array.isArray(dependencies)) {
    return dependencies;
  }

  try {
    const parsed = JSON.parse(dependencies);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function scopedDeployableNames(deployables: DeployScopeNode[], githubRepositoryId?: number | null): Set<string> {
  if (!githubRepositoryId) {
    return new Set(deployables.map((deployable) => deployable.name).filter(Boolean) as string[]);
  }

  const targetRepositoryId = normalizeRepositoryId(githubRepositoryId);
  const byName = new Map<string, DeployScopeNode>();
  deployables.forEach((deployable) => {
    if (deployable.name) {
      byName.set(deployable.name, deployable);
    }
  });

  const included = new Set(
    deployables
      .filter((deployable) => normalizeRepositoryId(deployable.repositoryId) === targetRepositoryId)
      .map((deployable) => deployable.name)
      .filter(Boolean) as string[]
  );

  let changed = true;
  while (changed) {
    changed = false;

    for (const deployable of deployables) {
      const name = deployable.name;
      if (!name || included.has(name)) {
        continue;
      }

      const requiredByIncluded = deployable.dependsOnDeployableName
        ? included.has(deployable.dependsOnDeployableName)
        : false;
      const explicitlyRequiredByIncluded = Array.from(included).some((includedName) =>
        deploymentDependencyNames(byName.get(includedName)).includes(name)
      );

      if (requiredByIncluded || explicitlyRequiredByIncluded) {
        included.add(name);
        changed = true;
      }
    }
  }

  return included;
}
