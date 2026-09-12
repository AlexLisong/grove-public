# Self-hosting

Grove requires Node 22.13+, PostgreSQL 17 and durable private storage. Choose your own infrastructure. Build with `npm ci && npm run build`; start with `npm start` under a process supervisor.

Provide configuration through a private environment file or secret manager. `.env.example` lists local placeholders; the app does not automatically load that file. The development launcher reads `.data/dev-env.json`. A production supervisor must inject variables itself.

Required settings:

- `NODE_ENV=production`, `APP_URL` set to your exact HTTPS origin.
- `HOST=127.0.0.1` and a chosen `PORT` behind a trusted HTTPS reverse proxy.
- `DATABASE_URL` for a dedicated database account; enable `DATABASE_SSL=true` when your database requires verified TLS.
- Independent random `SESSION_SECRET`, `APP_ENCRYPTION_KEY` (64 hex characters) and `REGISTRATION_CODE` values.
- For disk uploads, `FILE_STORAGE_BACKEND=local` and `UPLOAD_DIR` pointing to a private directory outside source and static assets. Alternatively configure `AZURE_STORAGE_ACCOUNT_URL` and `AZURE_STORAGE_CONTAINER` with appropriately scoped credentials.

The reverse proxy must serve the API and frontend on the same origin. Preserve streaming responses and set sensible upload limits and timeouts. Keep the database, upload directory and process listener inaccessible from the public network. Only the unprivileged application account should read private configuration and uploads.

AI and social connections are optional. See [provider setup](PROVIDER-SETUP.md). Website publishing is disabled until server-side destinations are configured; see [its contract](website-publishing.md).

Back up PostgreSQL consistently, private uploads, and the encryption/configuration needed to read them. Encrypt backups, limit access and test restoration in an isolated environment. Never place backups or credentials in this repository. Deployment, external account approval and backup operation are responsibilities of the installation owner.
