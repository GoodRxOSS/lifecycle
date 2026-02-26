# orgChart Global Config

## What it is

`orgChart` is a row in the `global_config` database table that holds a single value: the name of your organization's internal Helm chart.

```json
{ "name": "your-internal-chart-name" }
```

The system uses this name to distinguish org-internal Helm deployments from public/third-party chart deployments. This distinction drives fundamentally different deployment behavior at every stage of the pipeline.

## Why it exists

When a service in `lifecycle.yaml` declares a `helm` type deploy, there are two fundamentally different cases:

1. **Public/third-party chart** (e.g. `bitnami/redis`, `prometheus-community/prometheus`) — the chart is self-contained. No Docker image needs to be built; the chart ships its own container. Lifecycle only needs to pass identifying labels and any custom values.

2. **Org-internal chart** — the chart is a shared internal template that your org applies to its own services. Each service that uses it needs its own Docker image built and injected into the chart. Environment variables, init containers, resource configuration, and lifecycle-specific labels all need to be threaded through chart values in a standardized way.

The `orgChart` config is how Lifecycle knows which chart name is the internal one, so it can activate the org chart code path.

## How it's configured

The `orgChart` key is seeded into the database during initial migration (`src/server/db/migrations/001_seed.ts:459`):

```sql
INSERT INTO global_config (key, config, ..., description)
VALUES ('orgChart', '{"name":"replace_me"}', ..., 'Default internal helm chart for the org.');
```

You must update this to match your actual internal chart name. It is read at runtime from the `global_config` table through a three-tier cache (memory → Redis → DB) via `GlobalConfigService`.

The TypeScript type is defined in `src/server/services/types/globalConfig.ts:105-107`:

```typescript
export type OrgChart = {
  name: string;
};
```

The accessor used throughout the codebase is `GlobalConfigService.getOrgChartName()` (`src/server/services/globalConfig.ts:116-121`). The comment in that method notes this is intentionally kept as a DRY helper because the config is expected to evolve.

## How chart type is determined

Every Helm deploy is classified by `determineChartType()` in `src/server/lib/nativeHelm/utils.ts:893-907`:

```typescript
export async function determineChartType(deploy: Deploy): Promise<ChartType> {
  const orgChartName = await GlobalConfigService.getInstance().getOrgChartName();
  const helm = deploy.deployable.helm;
  const chartName = helm?.chart?.name;

  if (chartName === orgChartName && helm?.docker) {
    return ChartType.ORG_CHART;
  }

  if (chartName === 'local' || chartName?.startsWith('./') || chartName?.startsWith('../')) {
    return ChartType.LOCAL;
  }

  return ChartType.PUBLIC;
}
```

A deploy is classified as `ORG_CHART` only when **both** conditions hold:
- `chart.name` matches the `orgChart.name` from global config
- The deploy has a `helm.docker` configuration (meaning a Docker image is involved)

If the chart name looks like a file path (`./`, `../`, or literal `local`), it's `LOCAL`. Everything else is `PUBLIC`.

## Behavioral differences by chart type

| Behavior | ORG_CHART | LOCAL | PUBLIC |
|---|---|---|---|
| Docker image build | Yes — triggers `buildImageForHelmAndGithub()` | Yes — same as ORG_CHART | No — marked BUILT immediately |
| Git clone in deploy job | Yes (when repo info available) | Yes | Only if value files are declared |
| Global config values merged | Yes — from `configs[orgChartName].chart.values` | No | Yes — from `configs[chartName].chart.values` |
| Docker image injected into chart | Yes — `resourceType.appImage`, `version` | No | No |
| Init container handling | Yes — `resourceType.initImage` or `disableInit=true` | No | No |
| Env vars injected | Yes — `resourceType.env.KEY=value` (underscores escaped to `__`) | No | No |
| Lifecycle labels set | `env=lifecycle-{uuid}`, `lc__uuid={uuid}` | No | `commonLabels.name`, `commonLabels.lc__uuid` |
| `fullnameOverride` set | No | Depends on chart | Yes |
| Treated as "public" for GitHub deployments | Always | No | Yes (same as PUBLIC) |
| Treated as "public" in PR comment URLs | Yes (`!isPublicChart`) | Yes | Yes |
| Chart version (`--version`) supported | Yes | No | Yes |
| Validation | Requires `dockerImage` to be set | — | — |

### Env var key escaping

Helm does not support underscores in set key names for nested values. Lifecycle escapes `_` to `__` when injecting env vars:

```typescript
Object.entries(appEnvVars).forEach(([key, value]) => {
  customValues.push(`${resourceType}.env.${key.replace(/_/g, '__')}="${value}"`);
});
```

Your internal Helm chart template is expected to reverse this escaping when consuming `resourceType.env.*` values.

### Resource type prefix

Org chart values are namespaced under a `resourceType` prefix (e.g. `app`, `worker`). This comes from the `helm.type` field on the deployable and is resolved via `getResourceType()`. It lets the same internal chart support multiple resource types with separate image/env config.

## Code references

### Configuration and storage
- `src/server/services/types/globalConfig.ts:33,105-107` — TypeScript type definition
- `src/server/services/globalConfig.ts:116-121` — `getOrgChartName()` accessor
- `src/server/db/migrations/001_seed.ts:459` — Initial DB seed value

### Chart type detection
- `src/server/lib/nativeHelm/utils.ts:893-907` — `determineChartType()` (native Helm path)
- `src/server/lib/helm/helm.ts:224-232` — `helmDeployStep()` routing (legacy Codefresh path)

### Value assembly
- `src/server/lib/nativeHelm/utils.ts:679-736` — ORG_CHART branch in `constructHelmCustomValues()`
- `src/server/lib/nativeHelm/utils.ts:737-754` — PUBLIC branch (for comparison)
- `src/server/lib/nativeHelm/utils.ts:883-886` — Validation: requires `dockerImage` for ORG_CHART

### Deploy job construction
- `src/server/lib/nativeHelm/helm.ts:124-127` — Git clone decision in `generateHelmManifest()`

### Deploy service
- `src/server/services/deploy.ts:746-752` — Image build decision (ORG_CHART and LOCAL trigger builds; PUBLIC does not)
- `src/server/services/deploy.ts:864-867` — GitHub deployment visibility: org chart deploys are always treated as public

### PR comment / activity stream
- `src/server/services/activityStream.ts:1055-1058` — URL display: ORG_CHART and LOCAL deploys surface URLs in the PR comment

### Tests
- `src/server/lib/nativeHelm/__tests__/helm.test.ts:101-115` — `determineChartType()` unit tests
- `src/server/services/__tests__/deploy.test.ts:41,216-229` — GitHub deployment visibility tests
