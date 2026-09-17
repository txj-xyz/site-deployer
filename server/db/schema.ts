import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const DEPLOY_STATUSES = [
  'queued',
  'cloning',
  'building',
  'starting',
  'health_check',
  'routing',
  'live',
  'failed',
  'cancelled',
  'superseded',
] as const
export type DeployStatus = (typeof DEPLOY_STATUSES)[number]

/** Statuses from which a deployment can still change. */
export const TERMINAL_STATUSES: readonly DeployStatus[] = ['live', 'failed', 'cancelled', 'superseded']

export const sites = sqliteTable('sites', {
  id: text('id').primaryKey(),
  /** URL-safe slug; also used for container and image names. */
  name: text('name').notNull().unique(),
  /** Phase 2: the subdomain label routed to this site. Stored now so the schema is stable. */
  subdomain: text('subdomain').notNull(),

  sourceType: text('source_type').$type<'git' | 'local'>().notNull(),
  repoUrl: text('repo_url'),
  branch: text('branch').notNull().default('main'),
  localPath: text('local_path'),
  /** Path to a Dockerfile within the source tree. Null means detect/generate one. */
  dockerfilePath: text('dockerfile_path'),

  /** Port the app listens on inside the container. */
  containerPort: integer('container_port').notNull().default(3000),
  healthPath: text('health_path').notNull().default('/'),

  env: text('env', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  buildArgs: text('build_args', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),

  autoDeploy: integer('auto_deploy', { mode: 'boolean' }).notNull().default(true),
  desiredState: text('desired_state').$type<'running' | 'stopped'>().notNull().default('running'),
  /** The deployment currently serving traffic, if any. */
  currentDeploymentId: text('current_deployment_id'),

  /** Fully qualified hostname routed to this site, once it has been published. */
  hostname: text('hostname'),
  dnsRecordId: text('dns_record_id'),
  /** True only if we created the DNS record, and may therefore delete it. */
  dnsRecordOwned: integer('dns_record_owned', { mode: 'boolean' }).notNull().default(false),

  /** Git polling bookkeeping. */
  lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
  /** When this site is next due a poll. Pushed out on failure as a backoff. */
  nextPollAt: integer('next_poll_at', { mode: 'timestamp_ms' }),
  lastSeenSha: text('last_seen_sha'),
  /**
   * The commit the poller last launched a deploy for. Compared against the remote
   * head so a commit that fails to build is attempted once, not every cycle.
   */
  lastAttemptedSha: text('last_attempted_sha'),
  pollError: text('poll_error'),
  pollFailures: integer('poll_failures').notNull().default(0),

  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const deployments = sqliteTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),

    status: text('status').$type<DeployStatus>().notNull().default('queued'),
    trigger: text('trigger').$type<'manual' | 'git' | 'reconcile'>().notNull(),

    commitSha: text('commit_sha'),
    imageTag: text('image_tag'),
    containerId: text('container_id'),
    containerName: text('container_name'),
    /** Allocated per deployment, not per site, so a redeploy can run alongside the old one. */
    hostPort: integer('host_port'),
    /** The tunnel ingress origin this deployment was published under. */
    originService: text('origin_service'),

    error: text('error'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('deployments_site_idx').on(t.siteId, t.createdAt)],
)

export const deploymentLogs = sqliteTable(
  'deployment_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentId: text('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
    stream: text('stream').$type<'build' | 'system' | 'container'>().notNull(),
    line: text('line').notNull(),
  },
  (t) => [index('deployment_logs_deployment_idx').on(t.deploymentId, t.id)],
)

export type Site = typeof sites.$inferSelect
export type NewSite = typeof sites.$inferInsert
export type Deployment = typeof deployments.$inferSelect
