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

export const CONFIG_ARCHITECTURE_SECTION = `# Configuration Architecture

**Hierarchy:**
- lifecycle.yaml = SITEMAP/INDEX referencing other files
- dockerfile \u2192 Dockerfiles (build config)
- helm.valueFiles \u2192 Helm values (replicaCount, resources, ports)
- helm.chart \u2192 Local charts
- helm.values \u2192 Inline (often overridden by valueFiles)
- Configuration is DISTRIBUTED - follow references for actual values

**Verification Protocol (DO FIRST):**
1. Read lifecycle.yaml - find WHERE config lives
2. Read ACTUAL file via get_file
3. Extract CONFIGURED value
4. Compare runtime vs configured:
   - **Match** \u2192 INTENTIONAL. ASK: "Configured as X. Change it?"
   - **Mismatch** \u2192 BUG. Investigate + suggest fix
   - **ERROR logs** \u2192 FAILURE. Investigate regardless

**Never Assume:**
- \u2717 NO fixes without verifying actual config files
- \u2717 NO assuming replicaCount: 0 = bug without checking
- \u2717 NO claiming "X is set in Y" without reading Y
- \u2717 NO making up config values

## Drift & Connection Issues

### Configuration Drift

**Accessibility issues ("can't reach", "down", "unreachable"):**

**Think carefully through this logic:**

1. Check K8s state (deployments/statefulsets) for ACTUAL replicas
2. **IF** replicas=0 or not running:
   - READ actual config via get_file (NEVER assume/guess)
   - Compare config vs K8s
3. **Analysis (ONLY after reading config):**
   - **IF** Config=0 AND K8s=0 \u2192 INTENTIONAL (NOT a bug!)
   - **ELSE IF** Config>0 AND K8s=0 \u2192 MANUAL SCALE DOWN (drift detected)
   - **ELSE IF** Config=X AND K8s=Y (both>0) \u2192 MANUAL OVERRIDE (drift detected)

**Response patterns:**
- **Intentional:** "Service intentionally disabled (replicaCount: 0 in [file]). This is why it's unreachable. Change to 1?"
  - \u2717 Do NOT suggest as "fix" - working as configured!
- **Drift:** "Service has 0 replicas in K8s, but Helm values specify replicaCount: 2. Manual scale down detected (maintenance or accidental)."

**Drift principle:**
- ALWAYS compare: Config (files) vs Actual (K8s)
- Mismatches = manual kubectl/operator changes
- Report BOTH: "Config says X, cluster shows Y"
- Never assume manual changes are mistakes

**Common drift:**
Replica counts, resources, env vars, image tags, ports, probes, volumes

### Port Mismatch & Connections

**Connection failures ("Connection refused", "dial tcp", port errors):**

**Bidirectional verification:**
1. Service A \u2192 Service B connection failure:
   - Check A's env var (CLIENT_HOST=service-b:PORT)
   - Check B's ACTUAL config:
     a. K8s service exposed port
     b. B's Helm values ports
     c. B's lifecycle.yaml docker.ports
     d. B's running pods listening port

2. **Source of Truth:**
   - If B's K8s service, Helm, AND pods all use port X
   - But A's env var points to port Y
   - Truth = X (what B actually uses)
   - Fix = Update A's connection, NOT B's port!

3. **Verify Both Sides:**
   - \u2717 WRONG: "A can't connect to 8080, change B to listen on 8080"
   - \u2713 RIGHT: "Check what port B actually runs on first"
   - B runs 8070 everywhere \u2192 Update A to 8070
   - B config inconsistent \u2192 Fix B's config

**Investigation pattern:**
1. Identify failing connection (host:port)
2. Check TARGET config: K8s service + Helm values + lifecycle.yaml
3. Compare: configured vs running vs connected-to
4. Fix maintains consistency - don't break working services

**Truth determination:**
- 3/4 places use X, 1 uses Y \u2192 X likely correct
- Service works with X \u2192 Don't change to Y
- All of B's configs agree \u2192 That's B's truth
- Fix inconsistent service, not its dependencies`;
