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
  3. Optionally (--enable-anonymous-dcr) anonymous Dynamic Client Registration policies:
       - Trusted Hosts: relaxed so MCP clients on arbitrary (VPN) hosts can register
       - Allowed Client Scopes: extended with `mcp`
       - Max Clients: raised
     Consent Required and Allowed Protocol Mappers policies are left in place.
     NOTE: removing the Trusted Hosts policy is one-way — re-running with --skip-dcr
     (or disabling later) does not recreate it; restore from a realm backup if needed.

Usage:
  mcp-keycloak-setup.py \
      --keycloak-url http://localhost:8081 \
      --realm lifecycle \
      --admin-user admin --admin-password admin \
      --mcp-resource-url http://localhost:3000/mcp \
      [--enable-anonymous-dcr] [--max-clients 1000] [--dry-run]

Admin password may also be provided via KEYCLOAK_ADMIN_PASSWORD.
"""

import argparse
import json
import os
import sys
import urllib.error
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
            with urllib.request.urlopen(req, timeout=30) as resp:
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
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)['access_token']
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:200]
        raise SystemExit(f'Admin authentication failed: HTTP {error.code} {detail}')


def ensure_mcp_client_scope(admin: KeycloakAdmin, resource_urls: list) -> None:
    print('[1/3] client scope `mcp` + audience mapper(s)')
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

    # Identity mappers live on the `mcp` scope itself: DCR'd clients are assigned only this
    # scope (plus offline_access), never profile/email, so the claims the Lifecycle MCP server
    # uses for identity must come from here.
    identity_mappers = [
        {
            'name': 'mcp-username',
            'protocolMapper': 'oidc-usermodel-attribute-mapper',
            'config': {
                'user.attribute': 'username',
                'claim.name': 'preferred_username',
                'jsonType.label': 'String',
                'access.token.claim': 'true',
                'id.token.claim': 'false',
                'introspection.token.claim': 'true',
            },
        },
        {
            'name': 'mcp-email',
            'protocolMapper': 'oidc-usermodel-attribute-mapper',
            'config': {
                'user.attribute': 'email',
                'claim.name': 'email',
                'jsonType.label': 'String',
                'access.token.claim': 'true',
                'id.token.claim': 'false',
                'introspection.token.claim': 'true',
            },
        },
        {
            'name': 'mcp-github-username',
            'protocolMapper': 'oidc-usermodel-attribute-mapper',
            'config': {
                'user.attribute': 'githubUsername',
                'claim.name': 'github_username',
                'jsonType.label': 'String',
                'access.token.claim': 'true',
                'id.token.claim': 'false',
                'introspection.token.claim': 'true',
            },
        },
    ]
    for identity_mapper in identity_mappers:
        if any(m.get('name') == identity_mapper['name'] for m in mappers):
            admin.record(f"identity mapper {identity_mapper['name']} already present")
            continue
        admin.request(
            'POST',
            f'/client-scopes/{scope_id}/protocol-mappers/models',
            {**identity_mapper, 'protocol': 'openid-connect'},
        )
        admin.record(f"created identity mapper {identity_mapper['name']}")

    # One audience mapper per resource URL: 'mcp-audience' for the first, '-<n>' suffixed extras.
    for index, resource_url in enumerate(resource_urls):
        name = 'mcp-audience' if index == 0 else f'mcp-audience-{index + 1}'
        mapper = next((m for m in mappers if m.get('name') == name), None)
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
                    'name': name,
                    'protocol': 'openid-connect',
                    'protocolMapper': 'oidc-audience-mapper',
                    'config': mapper_config,
                },
            )
            admin.record(f'created audience mapper {name} -> {resource_url}')
        elif mapper.get('config', {}).get('included.custom.audience') != resource_url:
            mapper['config'].update(mapper_config)
            admin.request('PUT', f'/client-scopes/{scope_id}/protocol-mappers/models/{mapper["id"]}', mapper)
            admin.record(f'updated audience mapper {name} -> {resource_url}')
        else:
            admin.record(f'audience mapper {name} already correct')

    # Prune stale positional mappers left behind when the audience list shrinks,
    # so tokens stop carrying audiences of decommissioned MCP endpoints.
    expected = {'mcp-audience'} | {f'mcp-audience-{i + 1}' for i in range(1, len(resource_urls))}
    for mapper in mappers:
        name = mapper.get('name') or ''
        if name.startswith('mcp-audience') and name not in expected:
            admin.request('DELETE', f'/client-scopes/{scope_id}/protocol-mappers/models/{mapper["id"]}')
            admin.record(f'removed stale audience mapper {name}')


def ensure_realm_optional_scope(admin: KeycloakAdmin) -> None:
    print('[2/3] realm optional client scope registration')
    optional = admin.get('/default-optional-client-scopes') or []
    if any(s.get('name') == 'mcp' for s in optional):
        admin.record('`mcp` already a realm optional client scope')
        return

    scopes = admin.get('/client-scopes') or []
    scope = next((s for s in scopes if s.get('name') == 'mcp'), None)
    if not scope:
        if not admin.dry_run:
            raise SystemExit('client scope `mcp` not found; cannot register as realm optional scope')
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

    # Keycloak rejects a Trusted Hosts policy with both host and client-URI checks
    # disabled, and MCP clients register from arbitrary VPN hosts with localhost or
    # vendor-scheme redirect URIs that can never match a host allowlist. Removing the
    # anonymous policy component is the supported way to lift the restriction; consent,
    # allowed-scopes/mappers and max-clients policies continue to govern registration.
    trusted = find('trusted-hosts')
    if trusted:
        admin.request('DELETE', f'/components/{trusted["id"]}')
        admin.record('removed anonymous Trusted Hosts policy — VPN-only deployment assumption')
    else:
        admin.record('anonymous Trusted Hosts policy already absent')

    # providerId `allowed-client-templates` is the client-scopes policy (legacy name).
    # allow-default-scopes=true permits realm default + optional scopes, which now
    # includes `mcp` (registered as a realm optional scope above).
    scopes_policy = find('allowed-client-templates')
    if scopes_policy:
        config = scopes_policy.setdefault('config', {})
        if config.get('allow-default-scopes') != ['true']:
            config['allow-default-scopes'] = ['true']
            admin.request('PUT', f'/components/{scopes_policy["id"]}', scopes_policy)
            admin.record('enabled allow-default-scopes on Allowed Client Scopes policy')
        else:
            admin.record('Allowed Client Scopes policy already permits realm default/optional scopes (incl. mcp)')
    else:
        admin.record('WARNING: no anonymous Allowed Client Scopes policy found')

    max_clients_component = find('max-clients')
    if max_clients_component:
        config = max_clients_component.setdefault('config', {})
        try:
            current = int((config.get('max-clients') or ['200'])[0])
        except (TypeError, ValueError):
            current = 0
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
    parser.add_argument(
        '--mcp-resource-url',
        required=True,
        action='append',
        help='Canonical MCP URL used as token audience (repeatable for multiple deployments of one realm)',
    )
    parser.add_argument('--max-clients', type=int, default=1000)
    parser.add_argument(
        '--enable-anonymous-dcr',
        action='store_true',
        help='Configure anonymous Dynamic Client Registration policies (removes the anonymous '
        'Trusted Hosts policy — one-way; only for Keycloak instances not reachable from the public internet)',
    )
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    if not args.admin_password:
        raise SystemExit('admin password required (flag or KEYCLOAK_ADMIN_PASSWORD)')

    token = get_admin_token(args.keycloak_url, args.admin_user, args.admin_password)
    admin = KeycloakAdmin(args.keycloak_url, args.realm, token, args.dry_run)

    ensure_mcp_client_scope(admin, [u.rstrip('/') for u in args.mcp_resource_url])
    ensure_realm_optional_scope(admin)
    if args.enable_anonymous_dcr:
        print(
            'WARNING: enabling anonymous Dynamic Client Registration. This removes the anonymous\n'
            'Trusted Hosts policy (one-way) and lets anyone who can reach this Keycloak register\n'
            'OAuth clients. Only proceed if Keycloak is not reachable from the public internet.',
            file=sys.stderr,
        )
        ensure_dcr_policies(admin, args.max_clients)
    else:
        print('[3/3] anonymous DCR policies not configured (pass --enable-anonymous-dcr to opt in)')

    print('\nSummary:')
    for change in admin.changes:
        print(f'  - {change}')


if __name__ == '__main__':
    sys.exit(main())
