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

FROM node:20-slim AS base

ARG PORT

ENV PORT=$PORT
ENV BUILD_MODE=yes
ENV DATABASE_URL=no-db

RUN apt-get update && apt-get install -y \
  wget \
  unzip \
  curl \
  jq \
  git \
  procps \
  postgresql-client \
  net-tools \
  build-essential \
  # Required by aws cli
  python3 \
  # For arch-agnostic install of ejson2env
  ruby

# install helm 3
RUN curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 && \
  chmod 700 get_helm.sh && \
  ./get_helm.sh && \
  rm get_helm.sh

# Bash script for conditionally installing binaries based on architecture
COPY ./scripts/install_deps.sh ./scripts/install_deps.sh
RUN ./scripts/install_deps.sh

RUN npm install pnpm --global

# We need the codefresh CLI for triggering pipelines
RUN npm install codefresh@0.81.5 --global
RUN npm install dotenv-cli --global

FROM base AS packages

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM packages

COPY . .

RUN pnpm run build

EXPOSE $PORT

ENTRYPOINT [ "./scripts/k8-start.sh" ]
