/**
 * Hand-written, append-only migrations. Each entry runs once, in order, inside a
 * transaction, and the applied index is recorded in `schema_migrations`.
 * Never edit a migration that has shipped - add a new one.
 */
export const migrations: { name: string; sql: string }[] = [
  {
    name: '0001_init',
    sql: `
      CREATE TABLE sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        subdomain TEXT NOT NULL,
        source_type TEXT NOT NULL,
        repo_url TEXT,
        branch TEXT NOT NULL DEFAULT 'main',
        local_path TEXT,
        dockerfile_path TEXT,
        container_port INTEGER NOT NULL DEFAULT 3000,
        health_path TEXT NOT NULL DEFAULT '/',
        env TEXT NOT NULL DEFAULT '{}',
        build_args TEXT NOT NULL DEFAULT '{}',
        auto_deploy INTEGER NOT NULL DEFAULT 1,
        desired_state TEXT NOT NULL DEFAULT 'running',
        current_deployment_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued',
        trigger TEXT NOT NULL,
        commit_sha TEXT,
        image_tag TEXT,
        container_id TEXT,
        container_name TEXT,
        host_port INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX deployments_site_idx ON deployments(site_id, created_at);

      CREATE TABLE deployment_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        stream TEXT NOT NULL,
        line TEXT NOT NULL
      );
      CREATE INDEX deployment_logs_deployment_idx ON deployment_logs(deployment_id, id);
    `,
  },
  {
    name: '0002_cloudflare_routing',
    sql: `
      ALTER TABLE sites ADD COLUMN hostname TEXT;
      ALTER TABLE sites ADD COLUMN dns_record_id TEXT;
      ALTER TABLE sites ADD COLUMN dns_record_owned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE deployments ADD COLUMN origin_service TEXT;
    `,
  },
  {
    name: '0003_git_polling',
    sql: `
      ALTER TABLE sites ADD COLUMN last_polled_at INTEGER;
      ALTER TABLE sites ADD COLUMN next_poll_at INTEGER;
      ALTER TABLE sites ADD COLUMN last_seen_sha TEXT;
      ALTER TABLE sites ADD COLUMN last_attempted_sha TEXT;
      ALTER TABLE sites ADD COLUMN poll_error TEXT;
      ALTER TABLE sites ADD COLUMN poll_failures INTEGER NOT NULL DEFAULT 0;
    `,
  },
]
