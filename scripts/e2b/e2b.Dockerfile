# Lifecycle E2B sandbox template.
# Build context: repository root. Use:
#   npx @e2b/cli template create lifecycle-workspace \
#     --path ../.. \
#     --dockerfile scripts/e2b/e2b.Dockerfile \
#     --cmd "sh /opt/lifecycle/e2b-launcher.sh" \
#     --ready-cmd "test -d /tmp/lifecycle"
#
# Keep this self-contained instead of depending on lifecycleoss/workspace:latest; the E2B
# remote builder needs every gateway contract change baked into the template deterministically.

FROM node:22-slim

ENV HOME=/home/agent
ENV BUN_INSTALL=/home/agent/.bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update && apt-get install -y \
  bash \
  build-essential \
  ca-certificates \
  curl \
  gh \
  git \
  golang-go \
  python3 \
  ripgrep \
  unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

# code-server powers the in-sandbox browser editor for single-sandbox backends
# (E2B/OpenSandbox/Daytona/Modal), launched by e2b-launcher.sh / the gateway.
RUN curl -fsSL https://code-server.dev/install.sh \
  | sh -s -- --method=standalone --prefix=/usr/local --version=4.98.2

COPY sysops/workspace-gateway/package.json /opt/lifecycle-workspace-gateway/package.json
RUN cd /opt/lifecycle-workspace-gateway && npm install --omit=dev
COPY sysops/workspace-gateway/index.mjs /opt/lifecycle-workspace-gateway/index.mjs
COPY sysops/workspace-gateway/auth.mjs /opt/lifecycle-workspace-gateway/auth.mjs
COPY sysops/workspace-gateway/agentEnv.mjs /opt/lifecycle-workspace-gateway/agentEnv.mjs
COPY sysops/workspace-gateway/schema.mjs /opt/lifecycle-workspace-gateway/schema.mjs
COPY sysops/workspace-gateway/skills-lib.mjs /opt/lifecycle-workspace-gateway/skills-lib.mjs
COPY sysops/workspace-gateway/skills-bootstrap.mjs /opt/lifecycle-workspace-gateway/skills-bootstrap.mjs

RUN curl -fsSL https://bun.sh/install | bash

COPY scripts/e2b/e2b-launcher.sh /opt/lifecycle/e2b-launcher.sh

# The E2B v2 builder forces `USER user`, so the session home and workspace dirs the
# bootstrap expects must be pre-created writable.
RUN chmod +x /opt/lifecycle/e2b-launcher.sh \
  && mkdir -p /home/agent/.lifecycle-session /workspace \
  && chown -R 1000:1000 /home/agent /workspace \
  && chmod 0777 /home/agent /home/agent/.lifecycle-session /workspace

WORKDIR /workspace
