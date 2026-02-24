# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build & Run

- `pnpm dev` - Start development server with debug logging and pretty output
- `pnpm build` - Build Next.js frontend and compile TypeScript server code
- `pnpm start` - Start production server
- `pnpm run-prod` - Start production server on port 5001

### Testing & Linting

- `pnpm test` - Run Jest tests with 75% max workers
- `NODE_ENV=test jest path/to/test.ts` - Run a single test file
- `pnpm lint` - Run ESLint on TypeScript files in src/
- `pnpm lint:fix` - Run ESLint with auto-fix
- `pnpm ts-check` - Run TypeScript type checking

### Database

- `pnpm db:migrate` - Run Knex database migrations
- `pnpm db:rollback` - Rollback last migration
- `pnpm db:seed` - Run database seeds

### Schema Generation

- `pnpm generate:schemas` - Generate both JSON and YAML schemas from `src/server/lib/yamlSchemas/`
- Schemas are auto-generated via lint-staged when YAML schema TypeScript files change on commit

### Local Development with Tilt

- `kind create cluster --config sysops/tilt/kind-config.yaml --name lfc` - Create local Kubernetes cluster
- `kx kind-lfc` - Switch to local cluster context
- `tilt up` - Start local development environment with Kubernetes

## Architecture Overview

### Request Flow

GitHub webhooks arrive at `src/pages/api/webhooks/github.ts` → enqueued to `WEBHOOK_PROCESSING` BullMQ queue → processed by `WebhookService` → triggers `BuildService` or `Deploy` service jobs → Kubernetes workloads created for building and deploying.

The server entrypoint is `ws-server.ts`, which combines Next.js HTTP handling with a WebSocket server. All HTTP requests go through Next.js; WebSocket upgrades to `/api/logs/stream` are routed to the WS server for real-time K8s pod log streaming.

### Module Aliases

TypeScript paths (available at runtime via `module-alias` and `tsconfig-paths`):
- `server/` → `src/server/`
- `shared/` → `src/shared/`
- `src/` → `src/`
- `scripts/` → `scripts/`
- `root/` → project root

### Service Layer

All services extend `_service.ts`, which injects `db`, `redis`, `redlock`, and `queueManager` via the constructor. `createAndBindServices()` in `src/server/services/index.ts` instantiates all services and returns them as `IServices`. API routes access services through `req.services` (injected by middleware).

Key services:
- `BuildService` - Orchestrates full build lifecycle: parse YAML config, create Build/Deploy records, enqueue jobs
- `Deploy` - Executes individual service deployments via Codefresh, native Docker builds, or Helm
- `GithubService` - GitHub API operations, webhook processing, PR status updates
- `Environment` - Manages ephemeral environment lifecycles
- `GlobalConfig` - Singleton service for cached global configuration from the database

### Queue Architecture

Queues are managed by `QueueManager` (singleton) using BullMQ backed by Redis. Queue names are versioned with `JOB_VERSION` env var to isolate across deployments (defined in `src/shared/config.ts` as `QUEUE_NAMES`). Key queues: `WEBHOOK_PROCESSING`, `BUILD_QUEUE`, `RESOLVE_AND_DEPLOY`, `DELETE_QUEUE`, `INGRESS_MANIFEST`.

### Database Models

All models extend `_Model` (`src/server/models/_Model.ts`), which provides:
- `find`, `findOne`, `batch` - query helpers with eager loading support
- `create`, `upsert`, `softDelete`, `transact` - write helpers
- `timestamps: boolean` - auto-sets `createdAt`/`updatedAt`
- `hidden: string[]` - fields excluded from JSON serialization

Core entities: `Build`, `Deploy`, `Service`, `Environment`, `Repository`, `PullRequest`, `Deployable`, `GlobalConfig`.

### Deploy Types

Defined in `src/shared/constants.ts` as `DeployTypes` enum:
- `docker` / `github` - Kubernetes-deployed containers (native build via BuildKit or Kaniko)
- `helm` - Helm chart deployments
- `codefresh` - Legacy Codefresh CI pipeline
- `aurora-restore` - AWS Aurora DB restore
- `configuration` - Config-only service (no deployment)
- `externalHTTP` - External HTTP endpoints

### YAML Configuration

Services define their lifecycle config in a `lifecycle.yaml` file in their repo. The schema is versioned under `src/server/lib/yamlSchemas/` and validated via `yamlConfigValidator.ts`. Generated JSON/YAML schemas live in `src/server/lib/jsonschema/schemas/` and `docs/schema/yaml/`.

### Native Build System

`src/server/lib/nativeBuild/` supports BuildKit and Kaniko as build engines. Builds run as Kubernetes Jobs with init containers for git clone and (for Kaniko) registry login. Engine selection and resource defaults come from `GlobalConfig.buildDefaults`.

### API Route Pattern

API routes in `src/pages/api/` use `createApiHandler()` from `src/server/lib/createApiHandler.ts` for uniform error handling. Routes are versioned under `/api/v1/`.

### Shared Module

`src/shared/` contains code used by both server and client:
- `constants.ts` - Status enums (`BuildStatus`, `DeployStatus`), deploy type constants, label names
- `config.ts` - Runtime config accessor (reads from Next.js `serverRuntimeConfig` or env vars)
- `utils.ts` - Shared utility functions

### Configuration

- Database: `APP_DB_*` env vars (preferred) or `DATABASE_URL` (deprecated)
- Redis: `APP_REDIS_*` env vars (preferred) or `REDIS_URL` (deprecated)
- Auth: GitHub App OAuth (`GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, etc.) with optional Keycloak integration
- All runtime config accessed via helpers in `src/shared/config.ts`

## Testing Notes

- Use `NODE_ENV=test` for test runs
- Mock implementations in `src/server/lib/__mocks__/` and `src/server/services/__mocks__/`
- Database tests should use transaction rollbacks
- Jest configured with SWC for fast TypeScript compilation; module aliases mapped in `jest` config in `package.json`

## Development Environment Setup

Requires Docker, Kind, Kubectl, Tilt, and ngrok for full local development. AWS credentials needed for ECR access. See README.md for complete setup instructions.
