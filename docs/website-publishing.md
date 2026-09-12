# Website publishing

Grove can publish reviewed English and Simplified Chinese article snapshots to websites you control. Each destination receives a read-only PostgreSQL view of its own published articles.

## Configure destinations

Website publishing is disabled by default. Set `WEBSITE_PUBLISHING_SITES` to a JSON array in private server configuration, for example:

```json
[{"id":"journal","name":"Journal","domain":"journal.example"}]
```

Use stable, unique lowercase IDs (letters, digits and underscores; begin with a letter; at most 40 characters) and unique DNS names without a scheme or path. Up to 20 destinations are supported. Set `WEBSITE_PUBLISHING_WORKSPACE_ID` to the authorized workspace UUID. The server validates the binding and refuses to reassign an existing destination to another workspace or domain.

Removing a destination from configuration disables new writes to it; historical publication links remain readable from their saved database binding. Restore the destination configuration before withdrawing an old publication.

For an existing installation, preserve its destination IDs, domains and workspace binding when providing this configuration. This guide is not a migration that renames sites or grants new reader access. Back up and review existing constraints before changing a database schema.

## Write and review

Open **Website articles**, save a private draft, choose destinations and review the exact saved snapshot. Publish only after checking the content and preview. Later edits remain drafts until published again. Unpublish withdraws one destination while keeping the source document.

English and Chinese articles are reviewed independently. Changing a published slug or language requires withdrawing the previous destination first. Use durable public image URLs; private workspace links are not public image hosting.

## Reader contract

The dedicated `publishing` schema contains destination bindings, published snapshots and immutable approval/audit records. `PUBLISHING_SCHEMA` can select a different dedicated schema. A destination with ID `journal` reads `publishing.journal_articles`.

Views expose `site_id, locale, slug, title, excerpt, content, category, tags, featured, cover_image, date, reading_time, updated_at`. They exclude drafts, credentials, private IDs and unpublished rows. Create separate database reader roles with SELECT on only their own view; do not grant access to the application tables or audit records. Reader credentials belong in each website's private server configuration.

Authenticated API routes are `GET /api/articles/sites`, `GET /api/articles`, `POST /api/articles/:id/approve`, `POST /api/articles/:id/publish` and `POST /api/articles/:id/unpublish`. Writes require editor/source access and the publishing scope. Version and destination revision checks reject stale changes. Publication and its receipt commit together; retrying an approval does not publish twice.

Backups must include the publishing schema and separately protected reader credentials. Verify restore and reader isolation using a disposable database before relying on a recovery procedure.
