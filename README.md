# Grove

A self-hosted workspace for turning research into finished work. Capture notes and sources, connect them on boards, write with context, and review drafts before publishing.

Grove combines a React interface, an Express API and PostgreSQL. It is early-stage software with working core workflows and explicit gaps. It is independently implemented and is not affiliated with Eden or other products referenced in its feature research.

## What you can do

- Capture notes, links, documents and media in a searchable library.
- Organize sources on boards and a canvas; write linked documents and typed tables.
- Read saved material with highlights, personal notes and a knowledge graph.
- Use optional AI providers for source-aware chat and durable research workflows.
- Share deliberately with workspace roles, item permissions and scoped tokens.
- Review social drafts or website article snapshots before an explicit publishing action.

Provider integrations require your own authorized accounts and configuration. Grove does not include a licensed social research corpus, native mobile clients, offline synchronization, or a guarantee of feature parity with another product. See [feature coverage](docs/feature-coverage.md).

## Quick start

Requirements: Node.js 22.13+, npm, Python 3 and PostgreSQL 17. Docker is optional; the example below creates a disposable local database.

```sh
npm ci
docker run --name grove-postgres \
  -e POSTGRES_USER=grove -e POSTGRES_PASSWORD=grove_local_only \
  -e POSTGRES_DB=grove -p 127.0.0.1:55432:5432 -d postgres:17-alpine
python3 scripts/run-local.py
```

Open `http://localhost:5173`. The launcher creates `.data/dev-env.json` with random local secrets and private file permissions. Use its `REGISTRATION_CODE` in the sign-up form to create your account. Never share that file. For an existing database, edit its `DATABASE_URL` before starting the app.

No AI key is needed to explore notes, boards and tables. To enable generation, add your provider configuration to the private local configuration file; see [provider setup](docs/PROVIDER-SETUP.md). External API usage may incur charges.

## Development

```sh
npm run typecheck
npm test
npm run build
```

Tests need the local database above, or `TEST_DATABASE_URL` pointing to a disposable PostgreSQL database. They create and remove isolated schemas. See [verification](docs/VERIFICATION.md) for details and [contributing](CONTRIBUTING.md) for the review workflow.

## Explore the project

- [Using Grove](docs/USING-GROVE.md): capture → organize → write → review.
- [Architecture](docs/architecture.md): code map, boundaries and data flow.
- [API contract](docs/api-contract.md) and [workflows](docs/workflows.md).
- [Self-hosting](docs/self-hosting.md) and [provider configuration](docs/PROVIDER-SETUP.md).
- [Website publishing](docs/website-publishing.md) and [browser extension](extension/README.md).
- [Roadmap](ROADMAP.md), [security policy](SECURITY.md) and [community conduct](CODE_OF_CONDUCT.md).

## License and provenance

Original Grove code is available under the [MIT License](LICENSE). Bundled fonts retain their [upstream licenses](THIRD_PARTY_NOTICES.md). Third-party service names identify integrations and do not imply endorsement or grant access to those services.
