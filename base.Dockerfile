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

FROM node:20-slim

ARG TARGETARCH

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
  python3 \
  ruby \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 && \
  chmod 700 get_helm.sh && \
  ./get_helm.sh && \
  rm get_helm.sh

RUN if [ "$TARGETARCH" = "arm64" ]; then \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf awscliv2.zip aws/ && \
    curl -LO https://dl.k8s.io/release/v1.30.0/bin/linux/arm64/kubectl; \
  else \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf awscliv2.zip aws/ && \
    curl -LO https://dl.k8s.io/release/v1.30.0/bin/linux/amd64/kubectl; \
  fi && \
  chmod +x ./kubectl && \
  mv ./kubectl /usr/local/bin/kubectl

RUN npm install pnpm --global

RUN npm install codefresh@0.81.5 --global

RUN npm install dotenv-cli --global

ENV BUILD_MODE=yes
ENV DATABASE_URL=no-db

WORKDIR /app