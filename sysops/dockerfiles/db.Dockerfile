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

# db.Dockerfile
# This is a temporary solution for run a lifecycle postgres database locally
# please update and seed accordingly

FROM postgres:16-bookworm

# Environment variables
ENV POSTGRES_USER=lifecycle
ENV POSTGRES_PASSWORD=lifecycle
ENV POSTGRES_DB=lifecycle

RUN apt-get update && apt-get install -y gzip

