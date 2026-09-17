# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # API + all background loops on :8080 (tsx watch)
npm run dev:web      # Vite dev server on :5173, proxies /api -> :8080
npm run build        # tsc server/ -> dist/, vite build web/ -> dist-web/
npm start            # single process: Fastify serves dist-web/ and the API on :8080
npm run typecheck    # server only
npm run typecheck:web
```

Dependencies are locked with `bun.lock`; `bun install` and `npm install` both work.

**There is no test runner, linter or formatter in this project.** Verification is
`npm run typecheck && npm run typecheck:web && npm run build`, followed by the smoke test in
README.md (deploy `examples/hello-static` as a `local` site — needs Docker but no Cloudflare).
Do not add or invoke a test command that does not exist.

The observability stack is separate: `docker compose -f stack/compose.yaml --env-file .env up -d`
(cloudflared, prometheus, grafana, blackbox).

## Architecture

Single Fastify process (`server/index.ts`) that owns SQLite as the desired state and drives
Docker + the Cloudflare API to match it. Four loops start at boot and are stopped on SIGINT/SIGTERM:
the git poller, the reconciler, the Prometheus target writer, and the log-flush timer.

### The deploy saga is the spine

`server/deploy/engine.ts` defines an ordered `SagaStep[]` run by `server/util/saga.ts`:
`resolve-source → build-image → start-container → health-check → ensure-dns → route-ingress → promote`.
Any failure unwinds the completed steps in reverse via their `compensate`, including the step that threw —
so **every compensator must tolerate partial state and must never throw because there is nothing to undo.**
New deploy work belongs in a step with a compensator, not in ad-hoc code around the saga.

Invariants the rest of the code depends on:

- **Ports are per deployment, not per site.** The new container starts alongside the old one; the cutover
  is `route-ingress` moving one tunnel rule, and `promote` removes the old container afterwards.
- **`enqueue(siteId, ...)` (`deploy/queue.ts`) serializes work per site**, concurrent across sites. Anything
  that can start a deployment goes through it.
- **Container/image names derive from `site.name`**, which is why the API validates it against Docker's slug
  rules. Every container carries the `LABELS` from `config.ts` — that is how the reconciler recognises its own work.

### Config is the first module to execute

`server/config.ts` calls `process.loadEnvFile()` at module scope. ESM evaluates imports before the importing
module's body, so this is the only place guaranteed to run before anything reads `process.env`.
**Read env through `config`, never `process.env` directly**, or a value will be missing depending on import order.

### Cloudflare is optional by design

`server/cloudflare/router.ts` exports a `Router` interface with a real implementation and a plan-only one,
selected by whether all five Cloudflare vars are set. Plan-only logs the request it would have made and the
deploy proceeds. Missing credentials are a supported mode, not an error — keep new Cloudflare work behind the
`Router` interface so both paths stay whole. A DNS record the deployer did not create is never deleted
(`dnsRecordOwned`).

### Secrets have exactly one open point

`server/secrets/crypto.ts` seals site env values (AES-256-GCM) at the API boundary (`sealEnv` in `api/sites.ts`)
and they are opened only in the engine immediately before container creation. The API returns `maskEnv` output.
Do not add another `openEnv` caller or return decrypted values from a route. The key lives in `SECRET_KEY` or
`data/secret.key`; unsealed legacy rows stay readable and are re-sealed on save.

### Database

Drizzle over better-sqlite3 (WAL, foreign keys on). Migrations are **hand-written, append-only SQL in
`server/db/migrations.ts`** — add a new entry, never edit one that has shipped; the applied index is recorded
in `schema_migrations`. Timestamps are `integer(..., { mode: 'timestamp_ms' })`.

### Logs and SSE

`server/logs/bus.ts` batches log lines into one transaction every 100ms and fans them out over an EventEmitter;
`GET /api/deployments/:id/logs` replays history then streams, resumable with `?after=<id>`.
**Call `flushLogs()` before marking a deployment terminal**, or the last lines land after the client disconnects.

### Reconciler

`server/reconcile/index.ts` compares SQLite against Docker and Cloudflare on a timer and repairs drift.
Two deliberate restraints, both load-bearing: sites with an in-flight deployment are skipped entirely (mid-deploy
there are legitimately two containers and a moving ingress rule), and unclaimed ingress rules are only deleted
when `RECONCILE_PRUNE_INGRESS=true`. `failStaleDeployments()` runs at boot to retire deployments whose driving
process is gone.

### Metrics

The deployer's own `/metrics` exports per-container stats from the Docker API, labelled `site` from the container
label, using cAdvisor-compatible metric names (cAdvisor collects nothing on Docker Desktop — see README).
`metrics/targets.ts` rewrites a Prometheus `file_sd` JSON file on a timer (atomically) rather than hooking into
mutations, so deploys, teardowns and crashes all converge on the same file.

## Conventions

- Server is ESM + `NodeNext`: **relative imports need the `.js` extension** even from `.ts` sources. The web
  tsconfig uses `bundler` resolution and no extensions.
- Both tsconfigs are `strict` with `noUncheckedIndexedAccess`; index access yields `T | undefined`.
- Request bodies are validated with zod schemas at the top of each `server/api/*.ts` file.
- The dashboard has no router or data-fetching library: a ~20-line hash router and `usePoll` in `web/src/hooks.ts`,
  which keeps the last good value so a transient error does not blank the page.
- Status strings (`DEPLOY_STATUSES`) are duplicated in `server/db/schema.ts` and `web/src/api.ts`; change both.
- `dist/`, `dist-web/`, `data/` and `.env` are gitignored build/runtime artifacts — do not edit files there.

## State of the project

Phases 1–6 are written and typecheck/build clean, but **only the metrics phase has been exercised against real
infrastructure.** No image has been built, no container started, no DNS record or ingress rule created, and the UI
has not been rendered in a browser. Treat anything past "Docker is reachable" as unverified, and prefer confirming
behaviour with the smoke test over assuming it works. README.md's *Verification* and *Known gaps* sections track this.
