# Pod shells

Engineers can open Shell beside Logs in a service's Pods panel or use the shell action in the Environment pod table. Select a running container and choose Open shell. `/bin/sh` is the default; `/bin/bash` is available when installed in the image. The image must contain the selected shell. No debugging container is injected.

## Configuration and rollout

Set these environment variables on the core web process:

- `ENABLE_AUTH=true`
- `POD_EXEC_ENABLED=true` (default is disabled)
- `POD_EXEC_ALLOWED_ORIGINS=http://localhost:3000` for local development, or a comma-separated list of exact deployed UI origins, including scheme and port. Wildcards are unsupported.

The existing Helm `global.env` or web component `deployment.extraEnv` accepts these values. Keep the flag disabled until testing is complete. Set `NEXT_PUBLIC_POD_EXEC_ENABLED=true` in the matching UI deployment. Roll out core first (pod DTOs now include `podUid`), then UI. Both applications require their existing Keycloak configuration, with the UI access token accepted by core's configured issuer, audience and JWKS verifier. A disabled-auth local session cannot use exec.

For Tilt, set `POD_EXEC_ENABLED=true` in the core `.env` before `tilt up`; Tilt passes the local UI origin to the allowlist. The repository's setup uses `kind create cluster --config sysops/tilt/kind-config.yaml --name lfc`, then `tilt up`; there is no `tilt setup` command. See the README for GitHub App setup and ignored development secrets. Run the separate UI with its API URL pointing to the local core.

To disable access, turn off the core flag and roll its deployment. Existing shells close on process shutdown; the UI flag removes entry points. Logs are unchanged. Authenticated V2 log migration is a follow-up after shell acceptance.

## Authentication and target policy

The browser sends its current NextAuth access token in the first WebSocket message, never in the URL. Core verifies it with the existing JWT verifier and requires the existing interactive `user` or `admin` role. This matches current Environment write access; it does not add a per-repository user ACL. API keys are outside this browser feature.

Core resolves a live Environment and its stored namespace. This initial implementation requires a dedicated `env-<uuid>` namespace. It rejects sandboxes, build/Helm tooling, deleting pods, unknown containers and nonrunning containers. It compares pod UID and restart count with the selection and rechecks the target every 10 seconds. Regular containers, sidecars and running init containers are supported. Kubernetes exec addresses names and has no atomic pod-UID precondition, so the read-to-exec race cannot be eliminated by this API.

## Connection behavior

The connection ends on disconnect, target replacement, server shutdown, JWT expiry or 10 minutes without user input. Reconnect is explicit and fetches the current NextAuth session. Switching between Logs and Shell preserves the connection; changing pod/container, closing the dialog or navigating away disconnects it. Polling does not restart the terminal. JWT validation does not provide immediate identity-provider logout revocation.

Each core replica permits 64 total shell sockets, including pending authentication, and four active sessions per user. Authentication has a five-second deadline and upstream connection has ten seconds. Frames, browser output and upstream input buffers are bounded. These are per-process limits, not cluster-wide quotas. Load balancers must support WebSocket upgrades and a suitable idle timeout; periodic ping frames check liveness.

Audit events use the existing best-effort sink: opening, denied and closed, with user/target/session metadata. No keystrokes, output or credentials are recorded. An opening event records authorized intent, not proof that Kubernetes started a shell. Disconnecting the stream does not guarantee termination of detached processes started by the user.

The protocol is documented at `/api/docs` under `/api/v2/builds/{uuid}/pods/{podName}/exec`. The internal Kubernetes `/api/v1/.../exec` transport is independent of Lifecycle API versioning.
