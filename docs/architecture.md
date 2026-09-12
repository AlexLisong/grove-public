# Architecture

Grove uses one TypeScript codebase with explicit server and browser boundaries.

- `src/`: React views, editors, canvas, graph and client state. `src/api.ts` is the HTTP boundary.
- `shared/`: entity, table, graph and article contracts used by both layers.
- `server/core/`: authentication, permissions, entities, PostgreSQL, private files, jobs and rate limits.
- `server/ai.ts`, `workflow-*.ts`: optional inference and durable research steps.
- `server/integrations.ts`, `publishing.ts`, `articles.ts`: provider adapters and reviewed publication.
- `extension/`: browser capture companion with user-configured origin and scoped token.
- `tests/`: unit and PostgreSQL/HTTP integration tests with controlled provider responses.

An authenticated request resolves its user and workspace before accessing entities. Permissions follow content into search, exports, AI context and jobs. The database is authoritative; a browser draft is recovery state rather than permission to overwrite a newer revision.

Background work uses PostgreSQL leases and idempotency keys. Draft generation does not authorize delivery. Approvals bind a saved snapshot, and an uncertain external send is not blindly retried. Website readers receive only destination-specific published views, never private tables.

The current runtime starts the API and worker in one process. Scaling to separate workers requires explicit coordination and testing. File storage can use private local disk or an optional object-storage adapter; inference and third-party connections are optional server configuration. No client bundle should contain provider keys.

See [API contracts](api-contract.md), [workflow contracts](workflows.md), and [website publishing](website-publishing.md) before changing those boundaries.
