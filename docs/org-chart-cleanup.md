# Remove orgChart Bottleneck — Configurable valueMapping for Helm Deploys

## Context

The `orgChart` global config limits Lifecycle to a single Helm chart (`goodrx-app`) for Docker-build-based deployments. Any chart that needs image injection, env var passing, or init container handling must match this one name. This prevents teams from using other Helm charts that also need Docker builds (e.g., a custom worker chart, a different org chart).

**Goal**: Replace the rigid `orgChart` check with a configurable `valueMapping` on per-chart global config entries. Any chart with `helm.docker` and a `valueMapping` gets Docker builds + value injection. Existing `goodrx-app` configs continue working by adding `valueMapping` to its global config entry.

## Design Decisions

- **Remove `ChartType.ORG_CHART` entirely** — collapse to just PUBLIC and LOCAL
- **Add `valueMapping` to global config per chart** — configurable injection paths
- **lifecycle.yaml per-service can override** valueMapping from global config
- **Flat explicit paths with `{{resourceType}}` template variable** — resolved from existing `helm.type` field (defaults to `deployment`)
- **Update both native and legacy Codefresh Helm paths**
- **Backward compat via global config** — DB migration adds `valueMapping` to `goodrx-app`'s global config entry so existing lifecycle.yaml files work unchanged

## Files to Modify (10 source files + 2 test files)

| File | Change |
|---|---|
| `src/server/services/types/globalConfig.ts` | Add `ValueMapping` type, make `orgChart` optional |
| `src/server/models/yaml/YamlService.ts` | Add `valueMapping?: ValueMapping` to `Helm` interface |
| `src/server/lib/nativeHelm/constants.ts` | Remove `ORG_CHART` from `ChartType` enum |
| `src/server/lib/nativeHelm/utils.ts` | Rewrite `determineChartType()`, `constructHelmCustomValues()`, `validateHelmConfiguration()`, add helpers |
| `src/server/lib/nativeHelm/helm.ts` | Update git clone decision |
| `src/server/lib/helm/helm.ts` | Rewrite `helmDeployStep()` routing + refactor `helmOrgAppDeployStep()` |
| `src/server/services/deploy.ts` | Change build-image gating + GitHub deployment visibility |
| `src/server/services/activityStream.ts` | Remove orgChart from `buildStatusBlock`, update URL display |
| `src/server/services/globalConfig.ts` | Remove `getOrgChartName()` |
| `src/server/db/migrations/013_add_value_mapping.ts` | Add valueMapping to goodrx-app's global config entry |
| `src/server/lib/nativeHelm/__tests__/helm.test.ts` | Update determineChartType and constructHelmCustomValues tests |
| `src/server/services/__tests__/deploy.test.ts` | Update GitHub deployment visibility tests |

---

## Step 1: Type System

### 1a. Add `ValueMapping` type (`src/server/services/types/globalConfig.ts`)

```typescript
export type EnvMappingEntry = {
  path: string;
  format: 'array' | 'map';
};

export type ValueMapping = {
  appImage?: string;
  version?: string;
  initImage?: string;
  initVersion?: string;
  disableInit?: string;
  enableServiceLinks?: string;
  envLabel?: string;
  uuidLabel?: string;
  env?: EnvMappingEntry;
  initEnv?: EnvMappingEntry;
  affinity?: string;
  tolerations?: string;
};
```

Make `orgChart` optional on `GlobalConfig`: `orgChart?: OrgChart`

### 1b. Add `valueMapping` to Helm interface (`src/server/models/yaml/YamlService.ts:182`)

```typescript
readonly valueMapping?: ValueMapping;
```

---

## Step 2: Remove ChartType.ORG_CHART

### 2a. Remove from enum (`src/server/lib/nativeHelm/constants.ts:32-36`)

```typescript
export enum ChartType {
  PUBLIC = 'public',
  LOCAL = 'local',
}
```

### 2b. Simplify `determineChartType()` (`src/server/lib/nativeHelm/utils.ts:893-907`)

Remove the `orgChartName` check entirely. Only detect LOCAL vs PUBLIC:

```typescript
export async function determineChartType(deploy: Deploy): Promise<ChartType> {
  const chartName = deploy.deployable.helm?.chart?.name;
  if (chartName === 'local' || chartName?.startsWith('./') || chartName?.startsWith('../')) {
    return ChartType.LOCAL;
  }
  return ChartType.PUBLIC;
}
```

### 2c. Add `hasDockerBuild()` helper (`src/server/lib/nativeHelm/utils.ts`)

```typescript
export function hasDockerBuild(deploy: Deploy): boolean {
  return !!deploy.deployable?.helm?.docker;
}
```

---

## Step 3: Core — Rewrite `constructHelmCustomValues()` (`src/server/lib/nativeHelm/utils.ts:679-803`)

Replace the 3-branch if/else (ORG_CHART / PUBLIC / LOCAL) with a unified approach:

1. **All charts**: merge global config values + service values, template-resolve via `renderTemplate()`
2. **Charts with `valueMapping` + `helm.docker`**: inject image, env, init, labels via configurable paths from valueMapping. Uses `{{resourceType}}` template resolution.
3. **PUBLIC without valueMapping**: existing behavior (fullnameOverride, commonLabels, configurable label/tolerations/nodeSelector from global config)
4. **LOCAL**: existing behavior (fullnameOverride, commonLabels, envMapping backward compat). If LOCAL also has valueMapping, apply it.

### Helper functions to add:

```typescript
function resolveValueMappingPath(template: string, resourceType: string): string {
  return template.replace(/\{\{resourceType\}\}/g, resourceType);
}
```

Reuse existing `transformEnvVarsToHelmFormat()` (already supports both `array` and `map` formats at line 811).

### Key logic for valueMapping injection:

For each field in valueMapping that is set:
- `appImage` → `--set <resolved-path>=<deploy.dockerImage>`
- `version` → `--set <resolved-path>=<constructImageVersion(dockerImage)>`
- `initImage` → `--set <resolved-path>=<deploy.initDockerImage>` (when init image exists)
- `initVersion` → `--set <resolved-path>=<constructImageVersion(initDockerImage)>` (when init image exists)
- `disableInit` → `--set <resolved-path>=true` (when NO init image)
- `env` → `transformEnvVarsToHelmFormat(appEnvVars, env.format, resolved-path)`
- `initEnv` → `transformEnvVarsToHelmFormat(initEnvVars, initEnv.format, resolved-path)`
- `enableServiceLinks` → `--set <resolved-path>=disabled`
- `envLabel` → `--set <resolved-path>=lifecycle-{buildUUID}`
- `uuidLabel` → `--set <resolved-path>={buildUUID}`
- `affinity` → static env affinity entries under `<resolved-path>.requiredDuringScheduling...`
- `tolerations` → `generateTolerationsCustomValues(resolved-path, staticEnvTolerations)`

Fields not set in valueMapping are simply skipped — only mapped values are injected.

---

## Step 4: Update `mergeHelmConfigWithGlobal()` (`src/server/lib/nativeHelm/utils.ts:359-412`)

Include `valueMapping` in the merged config. Per-service `helm.valueMapping` overrides global `configs[chartName].valueMapping` (shallow merge at top level):

```typescript
valueMapping: { ...(globalConfig?.valueMapping || {}), ...(helm?.valueMapping || {}) },
```

---

## Step 5: Legacy Codefresh Path (`src/server/lib/helm/helm.ts`)

### 5a. Rewrite `helmDeployStep()` (line 224-232)

Replace org chart name check with valueMapping check:

```typescript
export async function helmDeployStep(deploy: Deploy): Promise<Record<string, any>> {
  const helm = deploy?.deployable?.helm;
  const hasDocker = !!helm?.docker;
  const hasValueMapping = !!helm?.valueMapping;

  if (hasDocker && hasValueMapping) {
    return await helmMappedDeployStep(deploy);
  }
  return await helmPublicDeployStep(deploy);
}
```

### 5b. Refactor `helmOrgAppDeployStep()` → `helmMappedDeployStep()`

Same pattern as the native path: read injection paths from valueMapping, resolve `{{resourceType}}`, inject only mapped values. Preserve ingress/gRPC/KEDA logic (those are driven by `helm.grpc`, `helm.disableIngressHost`, `kedaScaleToZero` — not by chart type).

---

## Step 6: Deploy Service (`src/server/services/deploy.ts`)

### 6a. Build image gating (line 746-752)

Change from `chartType !== ChartType.PUBLIC` to `hasDockerBuild(deploy)`:

```typescript
case DeployTypes.HELM: {
  if (hasDockerBuild(deploy)) {
    return this.buildImageForHelmAndGithub(deploy, runUUID);
  }
  // ... existing PUBLIC chart path (skip build)
}
```

### 6b. GitHub deployment visibility (line 864-867)

Replace orgChart name check. All Helm charts except LOCAL are treated as public for GitHub deployments:

```typescript
const isNonLocalHelm = serviceType === DeployTypes.HELM
  && (await determineChartType(deploy)) !== ChartType.LOCAL;
const isPublic = isFullYaml ? deployable?.public || isNonLocalHelm : service?.public;
```

---

## Step 7: Activity Stream (`src/server/services/activityStream.ts`)

### 7a. Remove orgChart from `buildStatusBlock` (line 901-942)

The `isSelectedDeployType` callback is always called with `null` (lines 806, 826, 856, 874), so the `orgChart` param is dead code. Remove `orgChart` from the callback signature. Remove the `getOrgChartName()` call on line 929.

### 7b. Update URL display (line 1055-1058)

Replace `!isPublicChart` with `hasDockerBuild` check:

```typescript
const hasDocker = !!deployable?.helm?.docker;
const servicePublic: boolean = build.enableFullYaml
  ? deployable.public || hasDocker || chartType === ChartType.LOCAL
  : service.public;
```

---

## Step 8: Remove `getOrgChartName()` (`src/server/services/globalConfig.ts:116-121`)

Delete the method. All call sites are updated in prior steps. Compile will verify nothing is missed.

---

## Step 9: Update native Helm git clone decision (`src/server/lib/nativeHelm/helm.ts:124-127`)

```typescript
const shouldIncludeGitClone =
  !!(repository?.fullName && deploy.branchName) && (chartType === ChartType.LOCAL || hasValueFiles || hasDockerBuild(deploy));
```

Charts with docker builds need git clone to access the Dockerfile. LOCAL charts always need it. PUBLIC-only charts need it only if they have value files.

---

## Step 10: Update validation (`src/server/lib/nativeHelm/utils.ts:883-886`)

Replace ORG_CHART-specific validation:

```typescript
if (helm?.docker && helm?.valueMapping?.appImage && !deploy.dockerImage) {
  errors.push('Docker image is required when valueMapping.appImage is configured');
}
```

---

## Step 11: Update `constructHelmCommand()` version flag (`src/server/lib/nativeHelm/utils.ts:234`)

Simplify to:

```typescript
if (chartVersion && chartType !== ChartType.LOCAL) {
```

---

## Step 12: DB Migration (`src/server/db/migrations/013_add_value_mapping.ts`)

Read the `orgChart` config to find the chart name, then add `valueMapping` to that chart's global config entry:

```typescript
// up(): Add valueMapping to the org chart's global config entry
const orgChartRow = await knex('global_config').where('key', 'orgChart').first();
const orgChartName = orgChartRow?.config?.name;

// Find the chart's global config entry and add valueMapping
config.valueMapping = {
  appImage: "{{resourceType}}.appImage",
  version: "version",
  initImage: "{{resourceType}}.initImage",
  initVersion: "{{resourceType}}.version",
  disableInit: "{{resourceType}}.disableInit",
  enableServiceLinks: "{{resourceType}}.enableServiceLinks",
  envLabel: "env",
  uuidLabel: "lc__uuid",
  env: { path: "{{resourceType}}.env", format: "map" },
  initEnv: { path: "{{resourceType}}.initEnv", format: "map" },
  affinity: "{{resourceType}}.customNodeAffinity",
  tolerations: "{{resourceType}}.tolerations"
};

// down(): Remove valueMapping from the config entry
```

**Deploy order**: Run migration BEFORE deploying new code so valueMapping exists when the new code resolves it.

---

## Step 13: Update Tests

### `src/server/lib/nativeHelm/__tests__/helm.test.ts`
- Remove `mockGetOrgChartName` mock setup
- Remove/rewrite `ChartType.ORG_CHART` test cases → test that charts with `helm.docker` return `PUBLIC`
- Add tests for `constructHelmCustomValues()` with valueMapping: image injection, env injection, partial mapping, `{{resourceType}}` resolution
- Add test: chart with valueMapping but no `helm.docker` → treated as PUBLIC (no image injection)

### `src/server/services/__tests__/deploy.test.ts`
- Remove `getOrgChartName` mock
- Rewrite org chart GitHub deployment test → test that any non-LOCAL Helm chart is treated as public

---

## Step 14: Update docs (`docs/org-chart-usage.md`)

Rewrite to document the new `valueMapping` system, migration from orgChart, and how to configure new charts with Docker builds.

---

## Example: goodrx-app global config after migration

```json
{
  "version": "3.7.2",
  "args": "--force --timeout 15m0s --wait",
  "action": "install",
  "chart": {
    "name": "goodrx-app",
    "repoUrl": "cm://h.cfcr.io/goodrx/default",
    "version": "2.3.0",
    "values": [
      "deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=eks.amazonaws.com/capacityType",
      "deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=In",
      "deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=ON_DEMAND",
      "serviceAccount.name=runtime-sa"
    ],
    "valueFiles": []
  },
  "valueMapping": {
    "appImage": "{{resourceType}}.appImage",
    "version": "version",
    "initImage": "{{resourceType}}.initImage",
    "initVersion": "{{resourceType}}.version",
    "disableInit": "{{resourceType}}.disableInit",
    "enableServiceLinks": "{{resourceType}}.enableServiceLinks",
    "envLabel": "env",
    "uuidLabel": "lc__uuid",
    "env": { "path": "{{resourceType}}.env", "format": "map" },
    "initEnv": { "path": "{{resourceType}}.initEnv", "format": "map" },
    "affinity": "{{resourceType}}.customNodeAffinity",
    "tolerations": "{{resourceType}}.tolerations"
  }
}
```

## Example: Adding a new chart with Docker builds

To enable Docker builds + value injection for a new chart (e.g., `my-custom-chart`), add a global config entry:

```json
{
  "version": "3.7.2",
  "args": "--timeout 10m0s --wait",
  "action": "install",
  "chart": {
    "name": "my-custom-chart",
    "repoUrl": "https://my-registry.example.com/charts",
    "version": "1.0.0"
  },
  "valueMapping": {
    "appImage": "image.repository",
    "version": "image.tag",
    "env": { "path": "extraEnv", "format": "array" }
  }
}
```

Then in `lifecycle.yaml`:

```yaml
services:
  - name: my-service
    helm:
      chart:
        name: my-custom-chart
      docker:
        defaultTag: latest
        app:
          dockerfilePath: ./Dockerfile
```

No `orgChart` reference needed. The presence of `helm.docker` triggers image builds, and `valueMapping` defines where values land.

---

## Verification

1. `pnpm ts-check` — all compile errors from removing ORG_CHART are resolved
2. `pnpm test` — all existing tests pass (with updates)
3. `pnpm lint` — no lint issues
4. Manual verification: confirm the `goodrx-app` global config entry with valueMapping produces identical `--set` values as the old hardcoded path for a deployment, job, and cronjob type
5. Verify a PUBLIC chart without valueMapping still works unchanged (e.g., postgresql)
6. Verify a LOCAL chart with envMapping still works unchanged

## Risks

- **Migration timing**: The DB migration must run before deploying new code. If code deploys first, charts that were ORG_CHART will lack valueMapping and get PUBLIC-without-docker behavior (missing image injection).
- **`envMapping` overlap**: LOCAL charts can now have both `envMapping` and `valueMapping`. Plan gives `valueMapping` precedence when both exist.
- **Ingress/gRPC in legacy path**: The refactored `helmMappedDeployStep()` must preserve ingress/gRPC/KEDA logic from `helmOrgAppDeployStep()` — those are driven by `helm.grpc`, `helm.disableIngressHost`, `kedaScaleToZero`, not by valueMapping.

## Implementation Progress

| Step | Status |
|---|---|
| Step 1: Type System | Pending |
| Step 2: Remove ChartType.ORG_CHART | Pending |
| Step 3: Rewrite constructHelmCustomValues | Pending |
| Step 4: Update mergeHelmConfigWithGlobal | Pending |
| Step 5: Legacy Codefresh Path | Pending |
| Step 6: Deploy Service | Pending |
| Step 7: Activity Stream | Pending |
| Step 8: Remove getOrgChartName | Pending |
| Step 9: Git clone decision | Pending |
| Step 10: Validation | Pending |
| Step 11: constructHelmCommand version flag | Pending |
| Step 12: DB Migration | Pending |
| Step 13: Tests | Pending |
| Step 14: Docs | Pending |
