# Copyright 2026 GoodRx, Inc.
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

FROM node:20-slim

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y \
  ca-certificates \
  git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/lifecycle-workspace-gateway

COPY sysops/workspace-gateway/package.json /opt/lifecycle-workspace-gateway/package.json
RUN npm install --omit=dev

COPY sysops/workspace-gateway/index.mjs /opt/lifecycle-workspace-gateway/index.mjs
COPY sysops/workspace-gateway/schema.mjs /opt/lifecycle-workspace-gateway/schema.mjs
COPY sysops/workspace-gateway/skills-lib.mjs /opt/lifecycle-workspace-gateway/skills-lib.mjs
COPY sysops/workspace-gateway/skills-bootstrap.mjs /opt/lifecycle-workspace-gateway/skills-bootstrap.mjs

EXPOSE 3000

CMD ["node", "index.mjs"]
