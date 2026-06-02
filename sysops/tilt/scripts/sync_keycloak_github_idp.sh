#!/bin/sh
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

set -eu

namespace="${1:-lifecycle-app}"
github_idp_secret="${2:-lifecycle-keycloak-github-idp}"
keycloak_url="${KEYCLOAK_URL:-http://localhost:8081}"

github_client_id="$(kubectl -n "$namespace" get secret "$github_idp_secret" -o jsonpath='{.data.clientId}' | base64 --decode)"

if [ -z "$github_client_id" ] || [ "$github_client_id" = "local-github-client-id" ]; then
  echo "Keycloak: GitHub IDP sync skipped reason=github_client_id_missing"
  exit 0
fi

echo "Keycloak: Waiting for lifecycle-keycloak statefulset to be ready..."
if ! kubectl -n "$namespace" rollout status statefulset/lifecycle-keycloak --timeout=300s; then
  echo "Keycloak: Timeout waiting for lifecycle-keycloak statefulset to be ready"
  exit 1
fi

# Give Tilt a brief moment to establish port-forwarding
sleep 5

tmp_current="$(mktemp)"
tmp_updated="$(mktemp)"
trap 'rm -f "$tmp_current" "$tmp_updated"' EXIT

get_admin_token() {
  curl -sS --max-time 10 -X POST "$keycloak_url/realms/master/protocol/openid-connect/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'username=admin' \
    --data-urlencode 'password=admin' \
    --data-urlencode 'grant_type=password' \
    --data-urlencode 'client_id=admin-cli' | jq -r '.access_token'
}

for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  token="$(get_admin_token || true)"
  if [ -n "$token" ] && [ "$token" != "null" ]; then
    status="$(curl -sS --max-time 10 -o "$tmp_current" -w '%{http_code}' \
      -H "Authorization: Bearer $token" \
      "$keycloak_url/admin/realms/lifecycle/identity-provider/instances/github" || true)"

    if [ "$status" = "200" ]; then
      current_client_id="$(jq -r '.config.clientId // ""' "$tmp_current")"
      if [ "$current_client_id" = "$github_client_id" ]; then
        echo "Keycloak: GitHub IDP already synced"
        exit 0
      fi

      jq --arg client_id "$github_client_id" \
        '.config.clientId = $client_id | .config.clientSecret = "${vault.github-client-secret}"' \
        "$tmp_current" > "$tmp_updated"

      update_status="$(curl -sS --max-time 10 -o /tmp/keycloak-github-idp-sync.out -w '%{http_code}' -X PUT \
        -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' \
        --data-binary "@$tmp_updated" \
        "$keycloak_url/admin/realms/lifecycle/identity-provider/instances/github" || true)"

      if [ "$update_status" = "204" ]; then
        echo "Keycloak: GitHub IDP synced"
        exit 0
      fi
    fi
  fi

  sleep 2
done

echo "Keycloak: GitHub IDP sync failed"
exit 1
