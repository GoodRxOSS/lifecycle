# Copyright 2025 GoodRx, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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
# (E2B/OpenSandbox/Daytona/Modal), launched by e2b-launcher.sh / the gateway. The Kubernetes
# path serves the editor from a separate container, so it is unused but harmless there.
# Pinned to match the Kubernetes editor image (codercom/code-server).
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

RUN mkdir -p /home/agent /workspace && \
  chown -R 1000:1000 /home/agent /workspace

WORKDIR /workspace
