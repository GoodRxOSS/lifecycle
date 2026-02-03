/**
 * Copyright 2025 GoodRx, Inc.
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

export const REFERENCE_SECTION = `# Configuration Architecture

**Hierarchy:** lifecycle.yaml = SITEMAP referencing other files. Configuration is DISTRIBUTED — follow references for actual values.
- dockerfile → Dockerfiles | helm.valueFiles → Helm values (replicaCount, resources, ports) | helm.chart → Local charts
- valueFiles override inline helm.values

## Configuration Drift

Compare config (files) vs actual (K8s):
- Config=0 AND K8s=0 → intentional (working as configured)
- Config>0 AND K8s=0 → MANUAL SCALE DOWN (drift detected)
- Config=X AND K8s=Y → manual override (drift detected)
Report both values, let user decide.

**Connection failures:** Check both sides. If target service uses port X everywhere but caller's env var says Y → fix caller, not target. Truth = what the target actually uses.

# Lifecycle Architecture

Lifecycle creates ephemeral environments from Pull Requests.

**Source of Truth (ranked):** 1. DB status 2. Config files (Helm values, Dockerfiles) 3. lifecycle.yaml 4. PR comment 5. K8s state 6. Events 7. Logs

**Build vs Deploy:** Builds first, deploys only if ALL builds succeed. Check builds before deploy issues.

**Build system:** buildPipelineId → Codefresh (get_codefresh_logs) | builderEngine → Native K8s (get_k8s_resources + get_pod_logs) | GITHUB type → no build

**K8s:** Deployments AND StatefulSets (check both). Labels: lc-service={serviceName}. Namespace: env-{buildUuid}.

## Database Queries

Batch with relations — ONE call:
\`query_database(table="builds", filters={"uuid": "xyz"}, relations=["pullRequest", "environment", "deploys.[deployable, repository]"])\`
Provides: build info, PR, environment, deploys, deployables, repos. READ-ONLY.

**Lifecycle logs:** \`get_lifecycle_logs(build_uuid="{buildUuid}")\` — for debugging Lifecycle itself (jobs not starting, environments not creating).

**Healthy:** All deploys READY/RUNNING in DB + all K8s ready>=1 AND ready==desired + no CrashLoopBackOff/ImagePullBackOff/Error.

# Multi-Repo Architecture

The PR repo branch contains ONLY lifecycle.yaml (environment config) — NOT service source code.
Each service's code lives in its OWN repository, shown as "Repo: Owner/name @ branch" in injected context.

**Single-repo environments:** The PR repo IS the service repo — use the PR repo directly.
**Multi-repo environments:** Query the deploys table to find the correct repo and branch for each service.

Use \`get_file\` with the service's repo and branch params to read service files.
If a service repo is inaccessible, tell the user explicitly — do not guess at file contents.
Always identify which repo a file is from when referencing it.
Never commit fixes to repos other than the PR repo.`;
