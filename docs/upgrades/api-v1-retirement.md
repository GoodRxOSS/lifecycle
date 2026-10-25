# Retire the v1 API

This release removes every `/api/v1/**` handler. Old API calls return 404. The v2 API keeps its existing session and API-key policies. This change does not redeploy environment services, move Jobs or change Kubernetes permissions.

Before the upgrade:

- Inventory ingress and internal callers, including scheduled automation. Move v1 calls to supported v2 operations. A quiet ingress sample does not prove that internal callers are absent.
- Deploy the ticket-capable Lifecycle UI and publish a distinguishable ticket-capable CLI release. Validate live pod, build and deploy logs and archived logs against the new API image.
- Coordinate the API and WebSocket replica cutover. Mixed versions can interrupt logs. Drain every old replica and anonymous socket before declaring the endpoint closed. Users must reopen disconnected views or rerun CLI commands.
- Confirm job-only workers have no custom HTTP consumers beyond GET `/api/health` and GET `/api/jobs`.
- Update existing GitHub App settings before a future setup or installation flow: setup URL `/api/setup/installed`, redirect URL `/api/setup/callback`, and the matching OAuth callback entry. Keep the existing Keycloak/user authorization callback and `/api/webhooks/github` webhook URL. Existing configured Apps are managed through installation settings, not the fresh setup API.

The environment banner now opens the authenticated environment page. It uses the existing `LFC_DASHBOARD_URL` metadata, so newly loaded banner scripts work in existing environments without a service redeploy. Already loaded or cached old scripts may still call the retired API until users refresh. The in-page anonymous log terminal is removed.

The old `/schema/validate` page now explains CLI and authenticated v2 validation. Use `lfc schema validate lifecycle.yaml` for a local file or sign in and use `lfc schema validate --repo owner/repository --branch branch-name`. `/v1/docs` redirects to `/v2/docs`.

## Fresh GitHub App setup

Fresh setup uses `/setup` and `/api/setup/**`. It requires an operator token and reads the live bootstrap Secret before changing credentials. Any existing credentials lock new App creation. A valid, matching fresh setup flow can finish installation and configuration. There is no HTTP path to replace an existing configured App.

Provide the same `LIFECYCLE_SETUP_TOKEN` to all web replicas, or use the token derived from their shared `ENCRYPTION_KEY`. The server does not log the token and does not generate per-process credentials. Operators with access to a web pod can retrieve the token without printing the encryption key:

```sh
kubectl exec -n <namespace> <web-pod> -- node -e 'const c=require("crypto"); const token=process.env.LIFECYCLE_SETUP_TOKEN?.trim(); if(token) process.stdout.write(token+"\n"); else { const key=process.env.ENCRYPTION_KEY?.trim(); if(!key || ["changeme","not_setup","replace_me","your_value_here"].includes(key.toLowerCase())) throw new Error("Configure LIFECYCLE_SETUP_TOKEN or ENCRYPTION_KEY"); process.stdout.write(c.createHmac("sha256",key).update("lifecycle-setup-token").digest("hex").slice(0,32)+"\n"); }'
```

Treat this output as a credential. Enter it in the setup form, keep it out of URLs and shared logs, and remove an explicit setup token after completion when it is no longer needed. Existing in-flight v1 setup links are rejected. Start a fresh setup flow using the new page.

Setup callback state expires after one hour and is consumed when its phase advances. Mutations serialize on the existing `app_setup` database row. Kubernetes Secret writes use the observed resource version. Nonsecret flow annotations bind retry recovery to the exact App credentials written by that flow. This permits retry after a Secret write succeeds but the database commit fails. A conflicting operator credential update locks the flow instead of adopting the changed credentials.

The installation callback verifies that the installation belongs to the App created by setup. Setup initializes only missing or known seed domain and registry defaults and preserves other configured values. It requests a rollout restart only after fresh installation is recorded. If a restart fails, retry the configure action or use the deployment tools. A restart accepted before a lost response may be repeated on retry.

## Verification still required for an installation

Run a fresh install rehearsal and verify callback state, Secret writes, configured-instance lockout, and queue bootstrap with the actual chart and authentication provider. Verify the banner in an existing environment with main-era injected metadata. Verify that all old v1 API paths return 404 on the built image, including each log alias and archived-log route. Unit tests do not establish private chart compatibility, actual client versions, production routing, or the absence of old listeners.
