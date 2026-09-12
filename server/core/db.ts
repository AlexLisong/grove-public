import pg, { type PoolClient, type QueryResultRow } from 'pg';

const connectionString = process.env.DATABASE_URL;
export const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.DB_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ...(process.env.DATABASE_SSL === 'true' ? {ssl: {rejectUnauthorized: true}} : {}),
});
pool.on('error', error => console.error('Database pool error', {message: error.message}));
// Checked-out clients have no pool idle-error listener. A dropped socket
// during a transaction/advisory lock must reject the work, not crash Node.
pool.on('connect', client => client.on('error', error => console.error(JSON.stringify({event:'database_client_error',code:(error as any).code,type:error.name}))));

export async function query<T = Record<string, any>>(text: string, params: any[] = []): Promise<T[]> {
  const result = await pool.query<QueryResultRow>(text, params);
  return result.rows as T[];
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {await client.query('ROLLBACK');} catch (rollback:any) {console.error(JSON.stringify({event:'database_rollback_failed',code:rollback.code,type:rollback.name}));}
    throw error;
  } finally { client.release(); }
}

export async function migrate() {
  await withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(718633241)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
        name text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id)
      );
      ALTER TABLE memberships ADD COLUMN IF NOT EXISTS item_only boolean NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE, csrf_token text NOT NULL,
        expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','editor','viewer')),
        token_hash text NOT NULL UNIQUE, invited_by uuid NOT NULL REFERENCES users(id),
        expires_at timestamptz NOT NULL, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS entities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind text NOT NULL, title text NOT NULL DEFAULT '', content text NOT NULL DEFAULT '',
        data jsonb NOT NULL DEFAULT '{}', tags text[] NOT NULL DEFAULT '{}',
        starred boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
        parent_id uuid REFERENCES entities(id) ON DELETE SET NULL,
        version integer NOT NULL DEFAULT 1, deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS entities_workspace_kind ON entities(workspace_id,kind,updated_at DESC);
      CREATE INDEX IF NOT EXISTS entities_parent ON entities(workspace_id,parent_id);
      CREATE INDEX IF NOT EXISTS entities_tags ON entities USING gin(tags);
      CREATE INDEX IF NOT EXISTS entities_search ON entities USING gin(to_tsvector('simple', title || ' ' || content));
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
      ALTER TABLE entities ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace' CHECK(visibility IN ('workspace','private'));
      CREATE TABLE IF NOT EXISTS entity_acl (
        entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission text NOT NULL CHECK(permission IN ('view','comment','edit')),
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(entity_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS entity_invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        email text NOT NULL,permission text NOT NULL CHECK(permission IN ('view','comment','edit')),
        token_hash text NOT NULL UNIQUE,invited_by uuid NOT NULL REFERENCES users(id),
        expires_at timestamptz NOT NULL,accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS entity_history (
        entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        version integer NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(entity_id,version)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id), content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES comments(id) ON DELETE CASCADE;
      ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved boolean NOT NULL DEFAULT false;
      ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(id);
      ALTER TABLE comments ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
      CREATE TABLE IF NOT EXISTS shares (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        entity_id uuid NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE,
        token text NOT NULL, enabled boolean NOT NULL DEFAULT true, allow_duplicate boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS files (
        id uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        storage_key text NOT NULL, original_name text NOT NULL, mime text NOT NULL, size bigint NOT NULL,
        backend text NOT NULL DEFAULT 'local', created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS files_workspace_storage ON files(workspace_id,backend,storage_key);
      CREATE TABLE IF NOT EXISTS usage_events (
        id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        action text NOT NULL, model text, input_tokens bigint NOT NULL DEFAULT 0,
        output_tokens bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS quota_kind text NOT NULL DEFAULT 'tokens';
      ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS usage_estimated boolean NOT NULL DEFAULT false;
      CREATE INDEX IF NOT EXISTS usage_workspace ON usage_events(workspace_id,created_at);
      CREATE TABLE IF NOT EXISTS quota_reservations (
        id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK(kind IN ('tokens','storage','image','transcription')),
        amount bigint NOT NULL CHECK(amount >= 0), metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS quota_workspace_kind ON quota_reservations(workspace_id,kind,expires_at);
      CREATE TABLE IF NOT EXISTS jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
        data jsonb NOT NULL DEFAULT '{}', result jsonb, error text, run_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
        lease_until timestamptz, lease_token uuid, dedupe_key text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(workspace_id,dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status,run_at,lease_until);
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id);
      CREATE TABLE IF NOT EXISTS connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        provider text NOT NULL, label text NOT NULL, credentials text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'unconfigured',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS connections_workspace ON connections(workspace_id);
      CREATE TABLE IF NOT EXISTS api_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL, token_hash text NOT NULL UNIQUE, scopes jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
      );
    `);
  });
}

export async function closeDb() { await pool.end(); }
