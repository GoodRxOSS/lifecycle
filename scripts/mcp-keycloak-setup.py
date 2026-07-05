#!/usr/bin/env python3
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
"""Configure an existing Keycloak realm for the Lifecycle MCP server.

Applies, idempotently, via the admin REST API (no reinstall / realm re-import):
  1. Client scope `mcp` with an audience protocol mapper whose custom audience is the
     canonical MCP resource URL (Keycloak's documented substitute for RFC 8707).
  2. Registers `mcp` as a realm *optional* client scope so dynamically registered
     clients can request it.
  3. Anonymous Dynamic Client Registration policies:
       - Trusted Hosts: relaxed so MCP clients on arbitrary (VPN) hosts can register
       - Allowed Client Scopes: extended with `mcp`
       - Max Clients: raised
     Consent Required and Allowed Protocol Mappers policies are left in place.

Usage:
  ./scripts/mcp-keycloak-setup.py \
      --keycloak-url http://localhost:8081 \
      --realm lifecycle \
      --admin-user admin --admin-password admin \
      --mcp-resource-url http://localhost:3000/mcp \
      [--max-clients 1000] [--skip-dcr] [--dry-run]

Admin password may also be provided via KEYCLOAK_ADMIN_PASSWORD.
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

POLICY_COMPONENT_TYPE = 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy'


class KeycloakAdmin:
    def __init__(self, base_url: str, realm: str, token: str, dry_run: bool):
        self.base_url = base_url.rstrip('/')
        self.realm = realm
        self.token = token
        self.dry_run = dry_run
        self.changes = []

    def request(self, method: str, path: str, body=None, mutating=True):
        url = f'{self.base_url}/admin/realms/{self.realm}{path}'
        if self.dry_run and mutating:
            self.changes.append(f'DRY-RUN {method} {path}: {json.dumps(body)[:160] if body else ""}')
            return None
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Authorization', f'Bearer {self.token}')
        if data is not None:
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors='replace')[:300]
            raise SystemExit(f'{method} {path} failed: HTTP {error.code} {detail}')

    def get(self, path: str):
        return self.request('GET', path, mutating=False)

    def record(self, message: str):
        self.changes.append(message)
        print(f'  * {message}')


def get_admin_token(base_url: str, user: str, password: str) -> str:
    body = urllib.parse.urlencode(
        {'grant_type': 'password', 'client_id': 'admin-cli', 'username': user, 'password': password}
    ).encode()
    req = urllib.request.Request(f'{base_url.rstrip("/")}/realms/master/protocol/openid-connect/token', data=body)
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)['access_token']


def ensure_mcp_client_scope(admin: KeycloakAdmin, resource_url: str) -> None:
    print('[1/3] client scope `mcp` + audience mapper')
    scopes = admin.get('/client-scopes') or []
    scope = next((s for s in scopes if s.get('name') == 'mcp'), None)

    if not scope:
        admin.request(
            'POST',
            '/client-scopes',
            {
                'name': 'mcp',
                'description': 'Lifecycle MCP server access (audience-bound token)',
                'protocol': 'openid-connect',
                'attributes': {
                    'include.in.token.scope': 'true',
                    'display.on.consent.screen': 'true',
                    'consent.screen.text': 'Access Lifecycle MCP tools on your behalf',
                },
            },
        )
        admin.record('created client scope `mcp`')
        scopes = admin.get('/client-scopes') or []
        scope = next((s for s in scopes if s.get('name') == 'mcp'), None)
    else:
        admin.record('client scope `mcp` already exists')

    if not scope:
        if admin.dry_run:
            admin.record('would create audience mapper (scope does not exist yet)')
            return
        raise SystemExit('client scope `mcp` not found after creation')

    scope_id = scope['id']
    mappers = admin.get(f'/client-scopes/{scope_id}/protocol-mappers/models') or []
    mapper = next((m for m in mappers if m.get('name') == 'mcp-audience'), None)
    mapper_config = {
        'included.custom.audience': resource_url,
        'access.token.claim': 'true',
        'id.token.claim': 'false',
        'introspection.token.claim': 'true',
    }

    if not mapper:
        admin.request(
            'POST',
            f'/client-scopes/{scope_id}/protocol-mappers/models',
            {
                'name': 'mcp-audience',
                'protocol': 'openid-connect',
                'protocolMapper': 'oidc-audience-mapper',
                'config': mapper_config,
            },
        )
        admin.record(f'created audience mapper -> {resource_url}')
    elif mapper.get('config', {}).get('included.custom.audience') != resource_url:
        mapper['config'].update(mapper_config)
        admin.request('PUT', f'/client-scopes/{scope_id}/protocol-mappers/models/{mapper["id"]}', mapper)
        admin.record(f'updated audience mapper -> {resource_url}')
    else:
        admin.record('audience mapper already correct')


def ensure_realm_optional_scope(admin: KeycloakAdmin) -> None:
    print('[2/3] realm optional client scope registration')
    optional = admin.get('/default-optional-client-scopes') or []
    if any(s.get('name') == 'mcp' for s in optional):
        admin.record('`mcp` already a realm optional client scope')
        return

    scopes = admin.get('/client-scopes') or []
    scope = next((s for s in scopes if s.get('name') == 'mcp'), None)
    if not scope:
        admin.record('would register `mcp` as realm optional scope (scope pending creation)')
        return

    admin.request('PUT', f'/default-optional-client-scopes/{scope["id"]}')
    admin.record('registered `mcp` as realm optional client scope (auto-assigned to DCR clients)')


def ensure_dcr_policies(admin: KeycloakAdmin, max_clients: int) -> None:
    print('[3/3] anonymous DCR registration policies')
    components = admin.get(f'/components?type={urllib.parse.quote(POLICY_COMPONENT_TYPE)}') or []
    anonymous = [c for c in components if c.get('subType') == 'anonymous']

    def find(provider_id):
        return next((c for c in anonymous if c.get('providerId') == provider_id), None)

    trusted = find('trusted-hosts')
    if trusted:
        config = trusted.setdefault('config', {})
        desired = {'host-sending-registration-request-must-match': ['false'], 'client-uris-must-match': ['false']}
        if config.get('host-sending-registration-request-must-match') != desired[
            'host-sending-registration-request-must-match'
        ] or config.get('client-uris-must-match') != desired['client-uris-must-match']:
            config.update(desired)
            admin.request('PUT', f'/components/{trusted["id"]}', trusted)
            admin.record('relaxed Trusted Hosts policy (host/client-uri matching off) — VPN-only deployment assumption')
        else:
            admin.record('Trusted Hosts policy already relaxed')
    else:
        admin.record('no anonymous Trusted Hosts policy found (nothing to relax)')

    scope_components = [c for c in anonymous if c.get('providerId') == 'allowed-client-scopes']
    for component in scope_components:
        config = component.setdefault('config', {})
        current = config.get('allowed-client-scopes', [])
        if 'mcp' not in current:
            config['allowed-client-scopes'] = current + ['mcp']
            config.setdefault('allow-default-scopes', ['true'])
            admin.request('PUT', f'/components/{component["id"]}', component)
            admin.record('added `mcp` to Allowed Client Scopes policy')
        else:
            admin.record('Allowed Client Scopes policy already includes `mcp`')
    if not scope_components:
        admin.record('no anonymous Allowed Client Scopes policy found')

    max_clients_component = find('max-clients')
    if max_clients_component:
        config = max_clients_component.setdefault('config', {})
        current = int((config.get('max-clients') or ['200'])[0])
        if current < max_clients:
            config['max-clients'] = [str(max_clients)]
            admin.request('PUT', f'/components/{max_clients_component["id"]}', max_clients_component)
            admin.record(f'raised Max Clients policy {current} -> {max_clients}')
        else:
            admin.record(f'Max Clients policy already >= {max_clients} ({current})')
    else:
        admin.record('no anonymous Max Clients policy found')

    consent = find('consent-required')
    admin.record('Consent Required policy present (kept)' if consent else 'WARNING: no Consent Required policy found')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--keycloak-url', required=True)
    parser.add_argument('--realm', default='lifecycle')
    parser.add_argument('--admin-user', default='admin')
    parser.add_argument('--admin-password', default=os.environ.get('KEYCLOAK_ADMIN_PASSWORD', ''))
    parser.add_argument('--mcp-resource-url', required=True, help='Canonical MCP URL used as token audience')
    parser.add_argument('--max-clients', type=int, default=1000)
    parser.add_argument('--skip-dcr', action='store_true', help='Only set up the scope/mapper; skip DCR policies')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    if not args.admin_password:
        raise SystemExit('admin password required (flag or KEYCLOAK_ADMIN_PASSWORD)')

    token = get_admin_token(args.keycloak_url, args.admin_user, args.admin_password)
    admin = KeycloakAdmin(args.keycloak_url, args.realm, token, args.dry_run)

    ensure_mcp_client_scope(admin, args.mcp_resource_url.rstrip('/'))
    ensure_realm_optional_scope(admin)
    if args.skip_dcr:
        print('[3/3] skipped DCR policies (--skip-dcr)')
    else:
        ensure_dcr_policies(admin, args.max_clients)

    print('\nSummary:')
    for change in admin.changes:
        print(f'  - {change}')


if __name__ == '__main__':
    sys.exit(main())
