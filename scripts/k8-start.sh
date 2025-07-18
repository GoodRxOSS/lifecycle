#!/bin/bash
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

set -e

cd /app

# check and error if required env vars are not set
required_vars=(
  DATABASE_URL
  REDIS_URL
  GITHUB_APP_ID
  GITHUB_CLIENT_ID
  GITHUB_APP_INSTALLATION_ID
  GITHUB_PRIVATE_KEY
  GITHUB_CLIENT_SECRET
  GITHUB_WEBHOOK_SECRET
  SECRET_BOOTSTRAP_NAME
  APP_HOST
)

missing=()
for v in "${required_vars[@]}"; do
  if [ -z "${!v}" ]; then
    missing+=("$v")
  fi
done

if [ ${#missing[@]} -ne 0 ]; then
  echo >&2
  echo "❌  Error: missing required environment variables!" >&2
  for var in "${missing[@]}"; do
    echo "   • $var is not set." >&2
  done
  echo >&2
  echo "Aborting startup due to missing configuration." >&2
  exit 1
fi

# codefresh auth create-context --api-key $CODEFRESH_API_KEY

forward_sigterm() {
  next_server_pid=$(ps -e | grep next-server | awk '{print $1}')
  if [[ -n "$next_server_pid" ]]; then
    kill -SIGTERM "$next_server_pid" 2>/dev/null
    while ps -p "$next_server_pid" >/dev/null 2>&1; do
      sleep 1
    done
  fi
  kill -SIGTERM "$child_pid" 2>/dev/null
}

trap forward_sigterm SIGTERM

pnpm db:migrate

pnpm run run-prod &
child_pid=$!

wait "$child_pid"

exit $?
