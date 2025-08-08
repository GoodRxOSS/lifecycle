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
  GITHUB_APP_ID
  GITHUB_CLIENT_ID
  GITHUB_APP_INSTALLATION_ID
  GITHUB_PRIVATE_KEY
  GITHUB_CLIENT_SECRET
  GITHUB_WEBHOOK_SECRET
)

db_configured=false
if [ -n "$APP_DB_HOST" ] && [ -n "$APP_DB_USER" ] && [ -n "$APP_DB_PASSWORD" ] && [ -n "$APP_DB_NAME" ]; then
  db_configured=true
elif [ -n "$DATABASE_URL" ]; then
  echo "⚠️  Using legacy DATABASE_URL configuration (falling back)"
  db_configured=true
fi

redis_configured=false
if [ -n "$APP_REDIS_HOST" ]; then
  redis_configured=true
elif [ -n "$REDIS_URL" ]; then
  echo "⚠️  Using legacy REDIS_URL configuration (falling back)"
  redis_configured=true
fi

missing=()

if [ "$db_configured" = false ]; then
  missing+=("DATABASE_URL or APP_DB_* variables")
fi

if [ "$redis_configured" = false ]; then
  missing+=("REDIS_URL or APP_REDIS_* variables")
fi

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

# Configure Codefresh CLI if API key is provided and not a placeholder
if [ -n "$CODEFRESH_API_KEY" ] && [ "$CODEFRESH_API_KEY" != "YOUR_VALUE_HERE" ]; then
  echo "Configuring Codefresh CLI authentication..."
  codefresh auth create-context --api-key $CODEFRESH_API_KEY
  echo "Codefresh CLI authentication configured successfully"
fi

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
