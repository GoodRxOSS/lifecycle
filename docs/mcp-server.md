# Lifecycle MCP Server

Lifecycle exposes a remote [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server so
AI coding tools can inspect your preview environments: list builds, check service status and URLs,
fetch build/deploy job logs, and browse published static sites.

- **Endpoint**: `https://<your-lifecycle-app-host>/mcp` (Streamable HTTP)
- **Auth**: OAuth 2.1 via your Lifecycle Keycloak realm — the same SSO login as the `lfc` CLI.
  Clients discover the auth settings automatically (RFC 9728 protected-resource metadata). When your
  admin has enabled anonymous dynamic client registration, clients also register themselves and you
  only paste the URL; otherwise your admin pre-registers a client and gives you its client ID (see
  [Without dynamic client registration](#without-dynamic-client-registration)).
- **Access tokens** are audience-bound to the MCP endpoint. CLI/API tokens are not accepted at
  `/mcp`, and MCP tokens are not accepted by the REST API.

## Connect your client

Replace `app.lifecycle.example.com` with your deployment's app host.

### Claude Code

```bash
claude mcp add --transport http lifecycle https://app.lifecycle.example.com/mcp
# then inside a session: /mcp -> lifecycle -> Authenticate (opens browser SSO)
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "lifecycle": { "url": "https://app.lifecycle.example.com/mcp" }
  }
}
```

Cursor shows a "Needs login" prompt on the server entry; completing it opens the browser SSO flow.

### VS Code (native MCP)

`.vscode/mcp.json` (or user-level `mcp.json`):

```json
{
  "servers": {
    "lifecycle": { "type": "http", "url": "https://app.lifecycle.example.com/mcp" }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.lifecycle]
url = "https://app.lifecycle.example.com/mcp"
```

Then run `codex mcp login lifecycle`.

On first login each tool registers itself with Keycloak (when anonymous dynamic client registration
is enabled) and you'll see a one-time consent screen listing the requested access.

## Tools

| Tool | Description |
| --- | --- |
| `list_builds` | List preview environments; supports `search`, `myEnvironmentsOnly`, pagination |
| `get_build` | Build detail by UUID, including services and their public URLs |
| `list_services` | Services in a build with status, branch, image, URL |
| `get_job_logs` | Build-job or deploy-job logs for a service (live pod logs or archived) |
| `list_sites` | Published static artifact sites |
| `get_site` | One site by id, including URL and expiry |

Resource: `lifecycle://builds/{uuid}` — build detail as a JSON document.

All v1 tools are read-only and run under your identity (e.g. `myEnvironmentsOnly` filters by your
GitHub login). Deploy environment variables are never included in tool output.

Note on visibility: like the REST API and UI, any authenticated user can read any build,
service, log, or site — `myEnvironmentsOnly`/`mineOnly` are convenience filters, not access
controls. This is intentional; if a preview environment's logs may contain sensitive data, treat
them as visible to all authenticated Lifecycle users.

## Server configuration (admins)

| Env var | Purpose |
| --- | --- |
| `MCP_SERVER_ENABLED` | Feature flag; the endpoint is absent unless `true` |
| `MCP_RESOURCE_URL` | Canonical resource URL, e.g. `https://app.lifecycle.example.com/mcp`. Access tokens must carry this value in `aud` |
| `KEYCLOAK_ISSUER` / `KEYCLOAK_JWKS_URL` | Shared with the REST API's auth config |
| `ENABLE_AUTH` | When `false` (local dev), `/mcp` runs unauthenticated with the local dev identity |

The MCP endpoint is served by the web process only (`LIFECYCLE_MODE` `web`/`all`).

### Keycloak realm setup

The realm needs a `mcp` client scope whose audience mapper adds `MCP_RESOURCE_URL` to tokens, plus
(optionally) anonymous dynamic client registration policies. Enable `mcp.enabled` + `mcp.resourceUrl`
on the `lifecycle-keycloak` chart — a post-install/post-upgrade Job configures the realm idempotently,
on both fresh installs and existing realms.

All URLs the realm is configured with (`mcp.resourceUrl` plus any `mcp.extraAudiences`) share a
**single token trust boundary**: every audience is added to the same `mcp` scope, so an access token
issued for one URL is accepted by all of them. Use `extraAudiences` only for alternate URLs of the
same deployment (e.g. the in-cluster URL and a host dev server) — never to share one realm across
production and staging.

Anonymous dynamic client registration is **off by default (`mcp.dcr.enabled`, default `false`)**.
Enabling it **deletes** the realm's anonymous Trusted Hosts policy — a one-way change that disabling
the setting later does not undo. Only enable it when Keycloak is **not** reachable from the public
internet; otherwise leave it off and pre-register a client instead. Back up the realm first if you
may want to revert.

### Without dynamic client registration

When `mcp.dcr.enabled` stays `false` (the secure default), MCP clients cannot self-register, so an
admin pre-registers one shared OAuth client in the realm and distributes its client ID:

1. In the Keycloak admin console (realm `lifecycle`), create a client: **OpenID Connect**, public
   (client authentication off), standard flow enabled, PKCE required (`Advanced -> Proof Key for
   Code Exchange Code Challenge Method: S256`).
2. Turn on **Consent required** in the client settings so users get the same one-time consent
   screen dynamically registered clients show.
3. Add the redirect URIs your users' tools need. MCP clients use loopback redirects, e.g.
   `http://127.0.0.1/*` and `http://localhost/*`; consult each tool's docs for exact values and
   tighten the patterns as far as your clients allow.
4. Assign the `mcp` client scope to the client (optional scope is enough — clients request it).
5. Share the client ID with users. Whether it can be used instead of dynamic registration depends
   on the MCP client: Claude Code supports `claude mcp add --transport http --client-id <id>`,
   Cursor supports a static `auth` block in `mcp.json`; VS Code and Codex CLI currently document no
   pre-registered client ID option and rely on dynamic client registration.
