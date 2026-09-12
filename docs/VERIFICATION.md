# Verification

Use Node 22.13+ and PostgreSQL 17. Install dependencies with `npm ci`.

```sh
npm run typecheck
npm test
npm run build
```

The suite defaults to the disposable database described in the README. Override it with `TEST_DATABASE_URL` when necessary. Tests create random schemas and remove them afterward; use a dedicated test database, never a production connection. Provider fixtures intercept external calls, so the test suite does not establish live provider compatibility or publishing permissions.

For UI changes, run the local application with synthetic content. Verify sign-in, the changed flow, keyboard focus, error recovery and a phone-sized viewport. For permission or publication changes, also exercise a second account and confirm denied access or stale approval rejection. Include these observations in the pull request.

CI runs type checking, the database-backed suite and the build. A successful build does not establish production capacity, external platform approval or a security audit.
