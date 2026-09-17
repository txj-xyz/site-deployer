# site-deployer

A self-hosted deploy dashboard for a home lab. Builds a site's Docker image, runs it,
routes a subdomain to it through a Cloudflare Tunnel, keeps it updated from git, and
reports traffic stats.

**Status: all six phases written. Typechecks and builds clean; not yet exercised against real Docker or Cloudflare.** See *Verification*.

| Phase | Scope | State |
|---|---|---|
| 1 | Deploy engine: source → image → container → health check → promote | **done, untested** |
| 2 | Cloudflare: DNS records + tunnel ingress + teardown | **done, untested** |
| 3 | React dashboard with live build logs | **done, untested** |
| 4 | Git polling + zero-downtime swap | **done, untested** |
| 5 | Docker-API exporter + Prometheus + Grafana + blackbox probes | **done, verified** |
| 6 | Reconciler, encrypted secrets, Cloudflare Access | **done, untested** |

## How a deploy works

Every deploy is a saga: an ordered list of steps, each with a compensating action.
If any step fails, the completed steps unwind in reverse, so a failure never leaves
an orphaned container or a half-configured site behind.

```
resolve-source → build-image → start-container → health-check → ensure-dns → route-ingress → promote
      │              │              │                  │            │             │            │
  git clone/     docker build   create+start      probe until   CNAME to      point the    remove old
  fetch/clean    (BuildKit)     on loopback       HTTP <500     the tunnel    hostname at  containers,
                                port                                          the new      prune images
                                                                              container
```

Routing happens **before** the old container is removed, so the cutover has no gap:
the ingress rule moves to the new container while the old one is still serving.

Key decisions and why:

- **Host ports are allocated per deployment, not per site.** A redeploy starts the new
  container alongside the old one and only swaps after the health check passes. A
  site-wide fixed port would make that impossible.
- **Ports bind to `127.0.0.1` only.** Nothing is reachable from the LAN; the tunnel is
  the only way in. Containers also join a shared bridge network so phase 2 can address
  them by container name instead.
- **Builds shell out to `docker build`** rather than using the Engine API's build
  endpoint, to get BuildKit caching and native `.dockerignore` handling. The deployer
  therefore needs the `docker` CLI available.
- **Images are built without a Dockerfile when the repo has none.** Detection order:
  configured path → repo `Dockerfile` → `package.json` with a `start` script (node) →
  `package.json` with a `build` script (static build behind nginx) → bare `index.html`
  (nginx). Generated files go in `<checkout>/.sitedeployer/`, never into the repo.
- **The tunnel ingress rule names the per-deployment container**, so replacing that
  one rule *is* the traffic cutover. Ingress is managed remotely via the Cloudflare
  API, so nothing reloads or restarts `cloudflared`.
- **A DNS record we did not create is never deleted.** If the CNAME already exists and
  already points at this tunnel, it is adopted and left alone on teardown. If it points
  somewhere else, the deploy fails rather than overwriting it.
- **One checkout per site, reused across deploys**, with `git clean -fdx` before each
  build. Fetches stay incremental; the context still exactly matches the commit.

## Requirements

- Node 22+
- Docker with the `docker` CLI, reachable from wherever this process runs
- `git`

## Setup

```bash
npm install
cp .env.example .env
```

Two processes in development — the API, and Vite serving the dashboard with `/api`
proxied back to it:

```bash
npm run dev       # API on :8080
npm run dev:web   # dashboard on :5173
```

For a single process, build once and let Fastify serve the built SPA:

```bash
npm run build && npm start   # everything on :8080
```

### Cloudflare

Leave the five Cloudflare variables blank and the deployer runs in **plan-only mode**:
every DNS and ingress call is logged as the request it would have made, and the deploy
otherwise proceeds normally. `GET /api/health` reports which variables are missing.

To go live, fill them in and start `cloudflared`:

```bash
docker compose -f stack/compose.yaml --env-file .env up -d
```

The API token needs `Zone:DNS:Edit` on the zone and `Account:Cloudflare Tunnel:Edit`.

Note on wildcards: a proxied wildcard DNS record generally needs a Business plan, which
is why each site gets its own CNAME. That is one API call per site, and the record id is
stored so teardown can remove exactly what it created.

### Running against Docker on another machine

The deployer is designed to run **on** the Docker host. For development against a
remote server, three things have to change:

```bash
DOCKER_HOST=ssh://you@your-server   # dockerode needs your key in an ssh-agent
PUBLISH_HOST_IP=0.0.0.0             # so the probe can reach the published port
PROBE_HOST=your-server.lan          # where health checks dial
```

`PUBLISH_HOST_IP=0.0.0.0` exposes every site's port on your LAN. Set both back to
`127.0.0.1` once the deployer runs on the server itself.

## Smoke test

Deploy the bundled static fixture, no git involved:

```bash
curl -sX POST localhost:8080/api/sites -H 'content-type: application/json' -d '{
  "name": "hello",
  "sourceType": "local",
  "localPath": "'"$PWD"'/examples/hello-static",
  "containerPort": 80
}' | jq

# follow the build
curl -N localhost:8080/api/deployments/<deploymentId>/logs

# the site itself
curl -s localhost:<hostPort from the deployment record>
```

Then tear it down:

```bash
curl -X DELETE localhost:8080/api/sites/<siteId>
```

## Git polling

Each git-backed site with auto-deploy on is checked for new commits with
`git ls-remote` — one round trip, no objects transferred, so a minute interval costs
nothing. On a new commit the normal deploy saga runs, which means the cutover is
already zero-downtime: the new container is built and health-checked alongside the
old one, and only then does the ingress rule move.

Three rules keep the loop from misbehaving:

- **A commit is attempted once.** `last_attempted_sha` records what the poller
  launched. If that deploy fails, the same commit is not rebuilt every minute — the
  site waits for a new commit, or a manual deploy.
- **Failures back off per site**, doubling up to 32× the interval, so an unreachable
  repo or a bad deploy key does not mean a failed `ls-remote` every minute forever.
  A successful check resets it.
- **Polling never overlaps a deploy.** A site with an in-flight deployment is skipped.

The loop ticks on a short timer and decides what to check from each site's
`next_poll_at`, so backoff is per site rather than global. `POST /api/sites/:id/check`
forces one immediately, and the dashboard exposes it as **Check for updates**, which
reports what it found rather than silently doing nothing.

Set `GIT_POLL_INTERVAL_MS=0` to disable polling entirely.

## Security

**Authentication.** Pick one:

- **Cloudflare Access** (recommended). Put an Access application in front of the
  dashboard hostname and set `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`. Every request is
  then challenged at the edge, and the deployer additionally verifies the signed
  assertion itself — so a request that somehow bypasses the edge still fails. The
  JWT check is done with `node:crypto` rather than a JWT library: Access only issues
  RS256 and Node imports a JWK directly, so it is a signature verify plus three
  claim checks, with no dependency in the auth path.
- **`DASHBOARD_TOKEN`**, for a dashboard that stays on the LAN. The UI prompts once
  and keeps it in an HttpOnly, SameSite=Strict cookie. Comparison is constant-time.

With neither set, the API is open and startup logs a warning. Do not expose it.

**Secrets at rest.** Site env values are encrypted with AES-256-GCM. The key comes
from `SECRET_KEY`, or is generated into `data/secret.key` (mode 0600) on first run —
**back that file up**, because losing it makes every stored value unreadable. Values
are decrypted at exactly one point, when the container is created; they are never
returned by the API, which exposes env keys with masked values. Rows written before
encryption existed stay readable and are re-sealed on the next save.

## Reconciler

Desired state (SQLite) is compared against reality (Docker, Cloudflare) on a timer
and repaired:

| Drift | Action |
|---|---|
| Container we own that no site claims | removed |
| Site's container stopped | started |
| Site's container gone entirely | redeployed |
| Ingress rule missing or pointing at the wrong container | corrected |
| Ingress rule under `BASE_DOMAIN` that no site claims | reported; removed only if `RECONCILE_PRUNE_INGRESS=true` |

Two deliberate restraints. **Sites with a deployment in flight are skipped entirely** —
mid-deploy there are legitimately two containers and a moving ingress rule, and
"repairing" that would fight the deploy saga. And **unclaimed ingress rules are not
deleted by default**, because they may belong to something else behind the same tunnel.

At boot, deployments left in a non-terminal status are marked failed: the process that
was driving them is gone, so they would otherwise sit at "building" forever.

`POST /api/reconcile` runs a pass immediately and returns what it found.

## Metrics

```
site containers ──► deployer /metrics ──┐
                                        ├──► Prometheus ──► Grafana + the dashboard
site URLs ──────► blackbox ─────────────┘        ▲
                                                 │
                            deployer writes file_sd targets
```

- **The deployer's own `/metrics`** gives per-container CPU, memory and network bytes,
  read from the Docker API and labelled with `site` straight from the
  `sitedeployer.site` container label, so everything is queryable per site with no
  manual configuration. Prometheus scrapes it at `host.docker.internal:$PORT`, and the
  endpoint is unauthenticated because a scrape config cannot read the dashboard token.
- This replaced **cAdvisor**, which collects nothing on Docker Desktop: its Docker
  handler resolves each container's read-write layer under `image/<driver>/layerdb/`,
  a tree the `overlayfs` (containerd) image store never creates, and it aborts handler
  setup when that lookup fails. The metric names are kept identical to cAdvisor's, so
  dashboards and recording rules are unaffected.
- **blackbox** probes each site for availability and response time. Targets come from
  a JSON file the deployer rewrites as sites come and go; Prometheus `file_sd` picks
  up changes without a reload. The file is written atomically, because a partial read
  would drop every probe for that interval.
- Each site is probed twice: **`internal`** hits the container directly, so it works
  with or without Cloudflare and measures the site rather than the path to it;
  **`public`** hits the real hostname. A healthy container behind a broken tunnel is
  therefore distinguishable from a broken container.
- The target file is rebuilt on a timer rather than hooked into every mutation, so
  deploys, teardowns and crashes all converge on the same correct file without the
  deploy path needing to know metrics exist.

Grafana is provisioned with a datasource and a **Sites** dashboard (availability,
response time, CPU, memory, network) on `127.0.0.1:3001`. The dashboard here shows the
same data per site, with sparklines and a numbers view.

### What is *not* here, and why

There are **no per-site HTTP request counts, status codes or per-route latency.**
Nothing in the request path speaks HTTP on the origin side — tunnel ingress goes
straight to each container, so there is no proxy to export those metrics. What you get
instead is network bytes (a good proxy for traffic volume), plus availability and
response time from the probes.

If you ever want real HTTP analytics, the two options are a reverse proxy in front of
the containers, or Cloudflare's GraphQL Analytics API for the edge view.

## Dashboard

Site list with live status, a create form, and a per-deployment log console that
streams over SSE. Three details that matter in use:

- **The log console auto-scrolls until you scroll up**, then stops fighting you and
  shows "scroll paused" until you return to the bottom.
- **Polling adapts**: 2s while a deployment is in flight, 10s once everything settles.
- **Plan-only mode is visible**, not silent. A banner names the missing Cloudflare
  variables so a deploy that logged its DNS calls instead of making them cannot be
  mistaken for one that published.

Routing is a ~20-line hash router (`#/`, `#/sites/:id`) rather than a dependency.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Also reports Docker connectivity |
| `GET` | `/api/sites` | Each site with its current deployment |
| `POST` | `/api/sites` | Creates and (unless `deployNow: false`) deploys |
| `GET` | `/api/sites/:id` | Site plus its last 20 deployments |
| `PATCH` | `/api/sites/:id` | Config changes; does not redeploy |
| `POST` | `/api/sites/:id/deploy` | `202` with a `deploymentId` |
| `POST` | `/api/sites/:id/check` | Polls the remote now; reports what it found |
| `POST` | `/api/sites/:id/stop` | Removes containers, keeps the site |
| `DELETE` | `/api/sites/:id` | Containers, images, checkout and rows |
| `GET` | `/api/deployments/:id` | One deployment record |
| `GET` | `/api/deployments/:id/logs` | SSE; replays history, then streams. `?after=<id>` to resume |
| `GET` | `/api/routes` | Cloudflare's live ingress list beside what we intend, for spotting drift |
| `GET` | `/api/sites/:id/metrics` | `?window=1h\|6h\|24h\|7d&scope=internal\|public` |
| `GET` | `/api/metrics/targets` | The probe targets we are handing Prometheus |
| `POST` | `/api/reconcile` | Runs a reconcile pass now; returns the drift it found |
| `POST` | `/api/login` | Token mode only; sets the session cookie |
| `GET` | `/healthz` | Liveness, unauthenticated |

## Layout

```
server/
  config.ts          env-derived config + container label names
  db/                schema, hand-written migrations, connection
  docker/            client, image build, container lifecycle, Dockerfile detection
  cloudflare/        API client, DNS records, tunnel ingress, plan-only fallback
  git/               checkout management, remote HEAD lookup, the poll loop
  deploy/            the saga and the per-site work queue
  logs/              batched log writer + SSE fan-out
  metrics/           Prometheus query client, file_sd target writer
  auth/              Cloudflare Access JWT verification, token mode
  secrets/           AES-256-GCM sealing for env values
  reconcile/         drift detection and repair
  api/               HTTP routes
web/                 React dashboard (Vite)
  src/components/    site list, detail, log console, create form, charts
stack/               cloudflared, prometheus, grafana, blackbox
examples/            fixtures to deploy while testing
```

## Verification

What has actually been checked:

| Check | Result |
|---|---|
| `tsc` over `server/` | passes |
| `tsc` over `web/` | passes |
| `vite build` | passes — 39 modules, 252 kB (78 kB gzipped) |
| Server startup sequence | runs: migrations, key load, reconciler, target writer, git poller |
| Unreachable Docker | logged, service continues — as designed |
| Missing Cloudflare credentials | detected, plan-only mode engaged, missing vars named |
| Grafana dashboard JSON | valid |
| Chart palette (6 colour checks, both modes) | passes |

What has **not** been checked: a real deploy. No image has been built, no container
started, no health check run, no DNS record or ingress rule created, and no page has
been rendered in a browser. Every code path past "Docker is reachable" is unexercised.

The first real test is the smoke test below, which needs only Docker — no Cloudflare.

## Known gaps

- Polling is the only git update trigger; there is no webhook receiver, so a push takes
  up to `GIT_POLL_INTERVAL_MS` to be noticed.
- Git credentials come from the ambient environment (ssh agent, credential helper).
  There are no per-site deploy keys, so a private repo fails to poll unless the
  deployer's own environment can reach it.
- Tunnel ingress is a read-modify-write of one list, guarded only by an in-process
  lock. Safe while this service is its only writer; editing ingress in the Cloudflare
  dashboard during a deploy can still lose an update.
- No per-site HTTP request counts or status codes — see *Metrics* above for why.
- Prometheus and Grafana have no authentication of their own; they bind to loopback.
- Build concurrency is unbounded across sites. Ten sites deploying at once means ten
  simultaneous `docker build` processes.
