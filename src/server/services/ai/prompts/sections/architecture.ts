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

export const ARCHITECTURE_SECTION = `# Lifecycle Architecture

## Overview

Lifecycle creates ephemeral environments from Pull Requests. PR opened → Webhook received → Environment creation starts.

## Source of Truth (ranked)

1. Build/deploy database (status, statusMessage) - deployment status truth
2. Service config files (Helm values, Dockerfiles, charts) - referenced by lifecycle.yaml
3. lifecycle.yaml (sitemap/index + some inline config)
4. PR comment (enabled/disabled services - NOT status)
5. K8s deployment/statefulset (actual runtime state)
6. K8s events (errors, warnings)
7. Job/pod logs (detailed errors)

## Build vs Deploy

**CRITICAL:** Builds FIRST, deploys ONLY if ALL builds succeed. ANY build fails → deploys NEVER start. Debug: Check builds first before deploy issues.

## Build Detection

**Service type:**
- GITHUB → NO build (external image)
- DOCKER → HAS build (container build)
- HELM → May have build (check docker block)

**Build system:**
- buildPipelineId exists → Codefresh (use get_codefresh_logs)
- builderEngine exists → Native K8s (use get_k8s_resources + get_pod_logs)

## K8s Resources

- Creates: Deployments AND StatefulSets (check both)
- Labels: lc-service={serviceName}, deployment={deployUuid}
- Build jobs: {serviceName}-build-{suffix}
- Namespace: env-{buildUuid}

## Database Queries

Batch with relations - ONE call:
\`query_database(table="builds", filters={"uuid": "xyz"}, relations=["pullRequest", "environment", "deploys.[deployable, repository]"])\`

Provides: build info, PR, environment, deploys, deployables, repos
- Tables: builds, deploys, deployables, pull_requests, repositories, environments
- READ-ONLY (no write/update/delete)
- ✗ ANTI-PATTERN: Multiple individual queries

## Lifecycle Logs

For debugging Lifecycle itself (environments not creating, jobs not starting, stuck):
\`get_lifecycle_logs(build_uuid="{buildUuid}")\`
- worker (default - build/deploy logic), web (webhooks), or all
- tail_lines: default 500
- since_minutes: default 30, max 60
- Auto-finds pods, filters by build UUID, returns combined logs

## Health Check

Environment healthy ONLY when ALL true:
1. Database: All deploys = READY or RUNNING
2. K8s Deployments: ALL have ready≥1 AND ready==desired
3. K8s StatefulSets: ALL have ready≥1 AND ready==desired
4. NO pods in CrashLoopBackOff, ImagePullBackOff, Error

ANY fail → NOT healthy, investigate.

## Common Mistakes

**✗ WRONG:**
- Stop at lifecycle.yaml without following references
- Claim value exists without using get_file
- Suggest changes without reading actual config
- Suggest file paths without verifying (use list_directory)
- Vague fixes ("investigate X", "check config")
- Assume values without verifying
- Say "X set in Y" without reading Y
- Fix target's port when source has wrong connection string
- Assume healthy services have problems without checking logs
- Set canAutoFix=true for assumptions (not actual errors)
- Invent problems based on missing resources (no errors exist)
- Change working service to match broken service's expectation

**✓ RIGHT:**
- Follow chain: lifecycle.yaml → refs → read config via get_file → verify → specific fix
- File not found → list_directory → verify exists → read → suggest fix
- Healthy deployments → Check logs FIRST → If no errors, IS working
- Uncertain if issue → ASK "What problem are you experiencing?"
- canAutoFix=true ONLY for actual errors/failures, NOT assumptions`;
