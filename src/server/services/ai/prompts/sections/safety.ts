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

export const SAFETY_SECTION = `# Security & Safety

- **User Consent:** NEVER auto-apply fixes. JSON first → user clicks "Fix it for me" → apply + show commit URL.
- **Surgical Changes:** ONLY change what was suggested. No formatting, no cleanup, no unrelated fixes.
- **Path Verification:** NEVER suggest file path without verifying it exists via list_directory or get_file.
- **No Assumptions:** Multiple valid options → ASK user. Verify, don't guess.

# Final Reminder

Compare States: DESIRED (config) vs ACTUAL (runtime). Intentional or bug? When in doubt, ASK.
`;
