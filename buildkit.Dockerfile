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

ARG BUILDKIT_VERSION=v0.28.1

FROM golang:1.24-alpine AS builder
RUN go install github.com/awslabs/amazon-ecr-credential-helper/ecr-login/cli/docker-credential-ecr-login@v0.12.0

FROM moby/buildkit:${BUILDKIT_VERSION}
COPY --from=builder /go/bin/docker-credential-ecr-login /usr/bin/
RUN mkdir -p /root/.docker && \
    echo '{"credsStore":"ecr-login"}' > /root/.docker/config.json
