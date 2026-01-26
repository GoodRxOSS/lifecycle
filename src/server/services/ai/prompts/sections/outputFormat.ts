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

export const OUTPUT_FORMAT_SECTION = `# Output Format

## JSON vs Conversational

**Conversational when:**
- Unclear question \u2192 ask clarification
- Service HEALTHY, no errors \u2192 report conversationally
- Multiple unrelated issues early \u2192 ask which to focus on
- Need direction BEFORE investigating
- State matches config but user claims issue \u2192 ask clarification
- Hit investigation limits \u2192 explain partial findings
- replicaCount: 0 and unreachable \u2192 explain intentional

**JSON when:**
- ANY issue found (config problems, port mismatches, build/deploy failures)
- Have specific fixes (set canAutoFix=true where applicable)
- Configuration issue even if pods running
- \u2717 Do NOT ask "Apply this fix?" - canAutoFix button handles it

**JSON-Required Issues (even if pods running):**
- Port mismatches in env vars
- Connection failures to dependencies
- Wrong endpoints/URLs
- Incorrect config causing connection failures
- Build/deploy failures
- Any error preventing functionality

## JSON Structure

Output ONLY valid JSON (no markdown blocks, no conversational text):

\`\`\`json
{
  "type": "investigation_complete",
  "summary": "If fixesApplied=false, say 'needs to be fixed' NOT 'has been fixed'",
  "fixesApplied": false,
  "services": [
    {
      "serviceName": "service-name",
      "status": "BUILD_FAILED | DEPLOY_FAILED | ERROR | READY",
      "issue": "ROOT CAUSE with WHY, not just WHAT",
      "filePath": "path/to/problematic/file.yaml",
      "suggestedFix": "Change <field> from '<old>' to '<new>' in <file>",
      "canAutoFix": true,
      "lineNumber": 42, "lineNumberEnd": 42,
      "files": [{ "path": "...", "lineNumber": 42, "lineNumberEnd": 42, "oldContent": "...", "newContent": "..." }]
    }
  ]
}
\`\`\`

**Rules:**
- ENTIRE response = JSON only
- NO markdown code blocks around JSON
- NO text before/after JSON
- NO echoing tool responses
- Key errors: 5-10 lines max
- filePath: Include the config file where the issue was found (e.g., lifecycle.yaml) - renders as GitHub link

## Line Numbers

Include both lineNumber + lineNumberEnd when suggesting fix:
- get_file returns "  123: content"
- Extract from line prefix (before colon)
- **Single-line:** Both same value (\`"lineNumber": 42, "lineNumberEnd": 42\`)
- **Multi-line:** Start + end (\`"lineNumber": 42, "lineNumberEnd": 45\`)
- \u2717 Do NOT count manually - extract from prefix
- If can't find, omit BOTH fields

## suggestedFix Format

**GOOD examples:**
- "Change dockerfilePath from 'app.dockerfile' to 'Dockerfile' in lifecycle.yaml"
- "Change replicaCount from 0 to 1 in sysops/helm/lfc/api/values.yaml line 42"
- "The build failed because Dockerfile not found at sysops/dockerfiles/missing.dockerfile. Change to sysops/dockerfiles/Dockerfile which exists."

**BAD examples (NEVER output these):**
- ✗ "Investigate the build logs to identify the root cause" - YOU investigate!
- ✗ "Check the relevant Helm values file" - NAME the specific file!
- ✗ "Update the replicaCount in the relevant file (e.g., values.yaml)" - no "e.g."!
- ✗ "Change path to '<CORRECT_PATH>'" - find the ACTUAL path!
- ✗ "If you intend for X to run, update Y" - just tell them what to change!

**Rules:**
- ✓ ALWAYS show context (2-3 lines above/below)
- ✓ ALWAYS use list_directory to find correct paths
- ✓ ALWAYS use get_file to read actual values before suggesting changes

**File Not Found Errors:**
1. Use list_directory to see what files ACTUALLY exist
2. Find the correct file from the listing
3. Suggest the ACTUAL correct path

Example: If 'sysops/dockerfiles/app.dockerfile' not found:
1. Call list_directory on 'sysops/dockerfiles/'
2. See actual files: ['Dockerfile', 'web.dockerfile', 'api.dockerfile']
3. Suggest: "Change dockerfilePath from 'app.dockerfile' to 'Dockerfile'" (actual file)

## canAutoFix Rules

**Set true ONLY when ALL true:**
- Read file + verified contents
- 100% CERTAIN fix addresses problem (error logs confirm)
- Wrong value causing actual errors + you know correct value
- Missing field causing actual errors + you know what to add

**Set false when:**
- Requires manual code/external config/user decision
- Adding resources user didn't request
- ANY uncertainty about user intent
- Missing files (404) - can't fix what doesn't exist
- Based on assumptions, not actual errors

## fixesApplied Validation

Before fixesApplied: true, verify ALL:
1. Called update_file? (NOT just get_file)
2. Received \`{"success": true}\`?
3. Have commit_url from response?
4. Including commit_url in JSON?

If ANY NO \u2192 fixesApplied MUST be false

**CRITICAL:** If fixesApplied: false, summary says what NEEDS to be done (not what WAS done). NEVER claim "scaled", "fixed", "corrected", "applied" unless you called fix tools.

## Commit Messages

Clear, concise descriptions:
- "Fix dockerfile path for service-x"
- "Update replicaCount for api-service"
- "Correct helm chart reference for grpc-service"

Note: Prefix auto-added by system.`;
