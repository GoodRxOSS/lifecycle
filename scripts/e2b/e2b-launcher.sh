#!/bin/sh
# Lifecycle E2B launcher — baked into the template as its start command.
#
# Template start commands run at template BUILD time and are snapshotted, so per-instance env
# (gateway token, session config) cannot reach them directly. Instead, the Lifecycle control plane
# delivers /tmp/lifecycle/instance.env (and the bootstrap scripts) over envd after sandbox create;
# this launcher polls for that file, sources it, bootstraps the workspace, and starts the gateway.
#
# CONTRACT (keep in sync with src/server/services/workspaceRuntime/providers/e2b.ts):
#   /tmp/lifecycle/instance.env    shell-sourceable env: LIFECYCLE_GATEWAY_TOKEN, session env,
#                                  LIFECYCLE_SESSION_WORKSPACE/HOME, MCP_PORT,
#                                  LIFECYCLE_EDITOR_PORT, LIFECYCLE_EDITOR_PROJECT_FILE, ...
#                                  (uploaded LAST — it is the start trigger)
#   /tmp/lifecycle/bootstrap.sh    optional workspace bootstrap (clone/install/skills)
# The gateway only becomes healthy after bootstrap succeeds, so the control plane's gateway
# readiness wait doubles as the bootstrap wait.

set -u

INSTANCE_ENV=/tmp/lifecycle/instance.env
mkdir -p /tmp/lifecycle

while [ ! -f "$INSTANCE_ENV" ]; do
  sleep 1
done

set -a
. "$INSTANCE_ENV"
set +a

mkdir -p "${LIFECYCLE_SESSION_HOME:-/home/user}" "${LIFECYCLE_SESSION_WORKSPACE:-/workspace}" /tmp

if [ -f /tmp/lifecycle/bootstrap.sh ]; then
  if ! sh /tmp/lifecycle/bootstrap.sh; then
    echo "lifecycle: workspace bootstrap failed; not starting the gateway" >&2
    exit 1
  fi
fi

# Editor is best-effort and image-dependent; the control plane probes /healthz and degrades gracefully.
if command -v code-server >/dev/null 2>&1; then
  (code-server "${LIFECYCLE_EDITOR_PROJECT_FILE:-${LIFECYCLE_SESSION_WORKSPACE:-/workspace}}" \
    --auth none \
    --bind-addr "0.0.0.0:${LIFECYCLE_EDITOR_PORT:-13337}" \
    --disable-telemetry \
    --disable-update-check &)
fi

exec node /opt/lifecycle-workspace-gateway/index.mjs
