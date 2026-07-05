# Lifecycle MCP Server

Lifecycle exposes a remote [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server so
AI coding tools can inspect your preview environments: list builds, check service status and URLs,
fetch build/deploy job logs, and browse published static sites.

- **Endpoint**: `https://<your-lifecycle-app-host>/mcp` (Streamable HTTP)
- **Auth**: OAuth 2.1 via your Lifecycle Keycloak realm — the same SSO login as the `lfc` CLI.
  Clients discover everything automatically (RFC 9728 protected-resource metadata + dynamic client
  registration); you only paste the URL.
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

On first login each tool registers itself with Keycloak and you'll see a one-time consent screen
listing the requested access.

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

## Server configuration (operators)

| Env var | Purpose |
| --- | --- |
| `MCP_SERVER_ENABLED` | Feature flag; the endpoint is absent unless `true` |
| `MCP_RESOURCE_URL` | Canonical resource URL, e.g. `https://app.lifecycle.example.com/mcp`. Access tokens must carry this value in `aud` |
| `KEYCLOAK_ISSUER` / `KEYCLOAK_JWKS_URL` | Shared with the REST API's auth config |
| `ENABLE_AUTH` | When `false` (local dev), `/mcp` runs unauthenticated with the local dev identity |

The MCP endpoint is served by the web process only (`LIFECYCLE_MODE` `web`/`all`).

### Keycloak realm setup

The realm needs a `mcp` client scope whose audience mapper adds `MCP_RESOURCE_URL` to tokens, plus
(optionally) anonymous dynamic client registration policies. Two equivalent ways to apply it:

1. **Helm** (fresh installs and upgrades): enable `mcp.enabled` + `mcp.resourceUrl` on the
   `lifecycle-keycloak` chart — a post-install/post-upgrade Job configures the realm idempotently.
2. **Script** (existing deployments): `scripts/mcp-keycloak-setup.py` applies the same changes via
   the admin API:

   ```bash
   ./scripts/mcp-keycloak-setup.py \
     --keycloak-url https://auth.lifecycle.example.com \
     --realm lifecycle \
     --admin-user admin \
     --mcp-resource-url https://app.lifecycle.example.com/mcp
   ```

   `--dry-run` prints the changes without applying; `--skip-dcr` limits it to the scope/mapper;
   `--mcp-resource-url` is repeatable when several MCP deployments share one realm.

Anonymous dynamic client registration removes the realm's anonymous Trusted Hosts policy and is
intended for deployments where Keycloak is **not** reachable from the public internet. If your
Keycloak is public, skip DCR (`--skip-dcr`) and pre-register a client instead.
