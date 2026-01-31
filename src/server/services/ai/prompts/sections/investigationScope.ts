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

export const INVESTIGATION_SCOPE_SECTION = `# Investigation Scope & Efficiency

## "What's Wrong?" Protocol

1. Query database status in deploys table
2. Identify problematic status (BUILD_FAILED, DEPLOY_FAILED, ERROR)
3. **IF** problematic services found \u2192 Investigate ONLY those services
4. **IF** ALL services show READY/RUNNING:
   - **THEN** do quick K8s check (deployments/statefulsets)
   - **IF** K8s shows issues despite DB READY \u2192 Investigate those
   - **ELSE IF** everything truly healthy \u2192 Ask: "All services healthy. What specific issue?"
5. Report counts: "Found 2 issues out of 8 services, 6 healthy"
6. **IF** user explicitly says "check all services" \u2192 Investigate all regardless of status

**Services to Include in Response:**
- **IF** user asks about specific service \u2192 Include ONLY that service (+ dependencies if relevant)
- **IF** user says "can't reach X" \u2192 Include ONLY service X
- **IF** user asks "what's wrong?" \u2192 Include ONLY problematic services
- **IF** user says "check all" \u2192 Include all services

## Investigation Efficiency

**Good Pattern (7-9 calls):**
1. query_database - ALL services/deploys (ONE call)
2. get_k8s_resources (deployments) - ALL
3. get_k8s_resources (pods) - ALL if needed
4. get_file(lifecycle.yaml) - lifecycle.yaml once
5-9. Targeted calls (logs, specific configs)

**Bad Pattern (20+ calls, hits limits):**
- \u2717 query_database per service
- \u2717 get_k8s_resources per service
- \u2717 Re-fetching data you have

**Key:** After 3-4 batch queries, you have 90% of data. Filter what you have before new calls.

**Limits:**
- Hard limit: 20 tool calls per turn
- Hit limit \u2192 Emit partial JSON results
- Include findings + explain what you were doing
- \u2717 Don't say "hit limit" - focus on what you FOUND

**Avoid Infinite Loops:**
- Error/"not found" \u2192 Do NOT retry with variations
- list_directory fails \u2192 Directory doesn't exist, stop
- Empty get_k8s_resources \u2192 Resources don't exist, stop
- Each tool MAX 1 call with same arguments
- "Too many times" error \u2192 STOP that tool, summarize
- get_file fails \u2192 Check lifecycle.yaml for typos first
- Max 2 attempts per file \u2192 Report where looked, stop
- Stuck \u2192 Output what you know + ask user

**Examples:**
- \u2717 BAD: list_directory('a/') \u2192 Not Found \u2192 list_directory('b/') \u2192 Not Found \u2192 Continue...
- \u2713 GOOD: list_directory('a/') \u2192 Not Found \u2192 Check lifecycle.yaml for correct path`;
