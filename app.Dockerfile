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

ARG BASE_IMAGE_TAG=v1
FROM lifecycleoss/app-base:${BASE_IMAGE_TAG} AS packages

ARG PORT

ENV PORT=$PORT

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

FROM packages

COPY . .

RUN pnpm run build

EXPOSE $PORT

ENTRYPOINT [ "./scripts/k8-start.sh" ]