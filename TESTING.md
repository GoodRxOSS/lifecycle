# Testing

Run `pnpm test` for the normal unit-test suites. Run `pnpm test:coverage` to enforce coverage for the Lifecycle API runtime: App and Pages API routes, server runtime code, shared runtime code, middleware, the custom HTTP/WebSocket server, and the workspace gateway.

The runtime coverage scope intentionally excludes:

- generated or declarative database code and migrations;
- type-only modules and pure re-export barrels;
- the build-time JSON-schema CLI.

Those files are outside the runtime API boundary and use generation or build verification instead of API unit coverage.
