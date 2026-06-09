# Changelog

## Unreleased

### Added

- Provider-agnostic workspace runtime backends: admins can select and configure **Kubernetes**
  (default), **OpenSandbox**, **E2B**, **Modal**, or **Daytona** as the agent-session workspace
  backend, with a capability catalog (`GET /api/v2/ai/workspace-runtime/backends`) and per-backend
  connection tests (`POST /api/v2/ai/workspace-runtime/backends/{id}/test-connection`).
- Backend credentials (`opensandbox.apiKey`, `e2b.apiKey`, `daytona.apiKey`, `modal.tokenId`,
  `modal.tokenSecret`) are now encrypted at rest with `ENCRYPTION_KEY`; existing plaintext values
  keep working and are migrated to ciphertext on the next config save. Read responses only ever
  expose `*Configured` presence flags.
- `PUT /api/v2/ai/config/agent-session/runtime` now merges `workspaceBackend` per-backend blocks
  instead of replacing the whole section: omitted blocks are preserved, present blocks are replaced
  as a whole (with omit-to-preserve for secret fields), and an explicit `<backend>: null` removes a
  stored block — refused while non-ended sandboxes still reference that provider.

### Security

- `ENABLE_AUTH=true` is mandatory for any shared or network-reachable deployment. With auth
  disabled, the workspace-backend configuration write path and the test-connection probe are
  exposed unauthenticated, allowing credential replacement and server-side request probing.
