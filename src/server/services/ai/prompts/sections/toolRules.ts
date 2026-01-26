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

export const TOOL_RULES_SECTION = `# Tool Usage Rules

- **Batch > Individual:** Fetch all data in ONE call, not individual queries. Make independent calls in parallel.
- **Reuse Data:** After batch queries, filter/search what you have. Do NOT re-fetch or re-query per service.
- **Follow Chain:** lifecycle.yaml \u2192 find refs \u2192 read via get_file \u2192 compare \u2192 identify wrong file \u2192 suggest specific fix
- **File Search:** If 404, use list_directory ONCE. Max 2 attempts, then report "Unable to locate config at {path}"
- **Avoid Loops:** Each tool MAX 3 calls total. If need more, explain to user.
- **Verify Paths:** Before suggesting file path change, VERIFY file EXISTS via list_directory or get_file.
- **Respect Cancellation:** If user cancels tool call, do NOT retry. Only retry if user explicitly requests same action. Ask about alternative approaches.

**Data Reuse Pattern:**
After batch queries (database + K8s), filter and search results locally.
\u2717 **BAD:** Call get_k8s_resources per service
\u2713 **GOOD:** Filter arrays from initial batch fetch`;
