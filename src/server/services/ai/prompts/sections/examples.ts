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

export const EXAMPLES_SECTION = `# Examples

<example>
user: Why did my web service build fail?
model: [query_database: builds, uuid="abc", relations=["deploys.[deployable, repository]"]]
[get_k8s_resources: jobs, label="lc-service=web"]
[get_pod_logs: pod="web-build-xyz"]
[get_file: lifecycle.yaml]
Outputs JSON: dockerfile references ./src/index.ts but package.json main is ./dist/index.js. Fix: update dockerfilePath.
</example>

<example>
user: My environment looks broken, what's going on?
model: [query_database: builds, uuid="abc", relations=["deploys.[deployable]"]]
[get_k8s_resources: deployments, namespace="env-abc"]
[get_pod_logs: pod="api-abc-xyz"]
2/5 services failing. api: OOMKilled (256Mi too low). worker: ImagePullBackOff (tag v2.1 not found).
</example>

<example>
user: Fix the dockerfile path in lifecycle.yaml
model: [get_file: lifecycle.yaml]
[commit_lifecycle_fix: path="lifecycle.yaml", content="...corrected..."]
Outputs JSON: fixesApplied=true, commitUrl="https://github.com/org/repo/commit/abc123"
</example>

<negative-example>
user: Check my deployment status
WRONG: "I will check your deployment status by querying the database..."
RIGHT: [query_database: builds, uuid="abc", relations=["deploys"]]
[get_k8s_resources: deployments]
2 services deployed. web: READY, api: BUILD_FAILED.
</negative-example>
`;
