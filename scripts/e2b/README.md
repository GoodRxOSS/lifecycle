# E2B workspace template (manual workflow)

The E2B workspace backend boots sandboxes from a prebuilt E2B *template* — a Firecracker snapshot
built from the Lifecycle workspace gateway plus the launcher in this directory.

**Preferred path:** admin settings → Runtime backends → E2B → **Create template** builds the
template on E2B from the published workspace image with this launcher overlaid, and selects it
automatically. The CLI flow below is the manual fallback (air-gapped setups, custom bases).

## Credentials

- `E2B_API_KEY` or CLI login — **operator credential** used by the `e2b` CLI to build/manage
  templates. Never commit it.
- `E2B_API_KEY` — the runtime credential Lifecycle uses to create sandboxes. Configure it in the
  admin settings (Workspace backend → E2B) or via the `E2B_API_KEY` env var on the API/worker.

## Build the template

```bash
cd lifecycle/scripts/e2b
export E2B_API_KEY=...   # operator credential (or `npx @e2b/cli auth login`)
npx @e2b/cli template create lifecycle-workspace \
  --path ../.. \
  --dockerfile scripts/e2b/e2b.Dockerfile \
  --cmd "sh /opt/lifecycle/e2b-launcher.sh" \
  --ready-cmd "test -d /tmp/lifecycle" \
  --cpu-count 2 --memory-mb 4096 \
  --no-cache
```

Notes:

- The start command (`--cmd`) **runs at template build time** and is snapshotted mid-poll; at
  sandbox create it resumes and picks up the per-instance files Lifecycle delivers over envd.
  That is why the launcher polls for `/tmp/lifecycle/instance.env` instead of reading env vars.
- The v2 build system runs the start command as the unprivileged `user` (v1 ran it as root):
  anything the launcher/bootstrap writes outside `/tmp` must be pre-created writable in the
  Dockerfile (see the `chmod 0777` line), and `/run` is remounted tmpfs at boot so it cannot
  carry baked-in paths.
- Template resources (CPU/memory) are **fixed at build time** — build presets if you need tiers.
- `e2b.Dockerfile` uses the repository root as build context and bakes the gateway files directly
  into the template. Do not point it at `lifecycleoss/workspace:latest`; that makes gateway contract
  changes depend on an out-of-band image push and can silently rebuild stale templates.
- The base image must be Debian-based, single-stage, and the kernel is pinned at build time: rebuild
  the template when you ship gateway or launcher changes.
- `e2b-launcher.sh` is a contract with
  `src/server/services/workspaceRuntime/providers/e2b.ts` (file paths, env names, gateway/editor
  startup order). Change them together.

## Wire it into Lifecycle

In admin settings (Workspace backend → E2B) set:

- **API key**: a runtime `E2B_API_KEY`
- **Template**: the template name/alias or ID from the build above (e.g. `lifecycle-workspace`)

Then use "Test connection" to verify the key and that the template exists with a ready build.
