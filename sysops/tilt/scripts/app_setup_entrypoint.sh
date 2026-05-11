#!/bin/sh
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

set -eu

db_setup_fingerprint() {
  find src/server/db/migrations src/server/db/seeds src/server/db/migration-helpers.ts -type f -print | sort | xargs sha256sum | sha256sum | awk '{print $1}'
}

case "${CODEFRESH_API_KEY:-}" in
  "" | "not_setup" | "replace_me")
    echo "Codefresh: skipping auth CODEFRESH_API_KEY is not configured"
    ;;
  *)
    if ! codefresh auth create-context --api-key "$CODEFRESH_API_KEY"; then
      echo "Codefresh: auth failed; continuing without Codefresh context"
    fi
    ;;
esac

if [ "${LIFECYCLE_MODE:-all}" != "job" ]; then
  db_setup_stamp="/tmp/lifecycle-db-setup-fingerprint"
  db_setup_current="$(db_setup_fingerprint)"
  db_setup_previous="$(cat "$db_setup_stamp" 2>/dev/null || true)"

  if [ "$db_setup_current" != "$db_setup_previous" ]; then
    pnpm db:seed
    pnpm db:migrate
    printf '%s\n' "$db_setup_current" > "$db_setup_stamp"
  else
    echo "Database: skipping setup inputs unchanged"
  fi
fi

exec pnpm dev
