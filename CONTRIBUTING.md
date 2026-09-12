# Contributing to Grove

Contributions to documentation, accessibility, reproducible bug reports and focused code changes are welcome. Read the [README](README.md) to run the application and the [architecture guide](docs/architecture.md) to find the relevant boundary.

## Find useful work

The [roadmap](ROADMAP.md) lists current directions; the [coverage ledger](docs/feature-coverage.md) records narrower gaps. For a larger feature or a new provider, open an issue describing the user need, proposed behavior and configuration requirements before implementing it. Small documentation fixes can go directly to a pull request.

## Make a change

1. Fork the repository and create a focused branch.
2. Use Node 22.13+ and a disposable local PostgreSQL database. Run `npm ci`.
3. Keep workspace permissions, approval gates, quota accounting and private-data boundaries intact. Add a regression test when behavior changes.
4. Run `npm run typecheck`, `npm test` and `npm run build`. For UI changes, verify keyboard navigation and a narrow viewport and include a screenshot using synthetic content.
5. Open a pull request explaining the problem, resulting behavior and verification. Call out schema/configuration changes and limitations.

Keep changes small enough to review. Do not mix formatting sweeps with behavior changes. Follow the existing TypeScript patterns. SQL must use bound parameters; identifiers must be validated before interpolation. External tool output is untrusted, and outbound side effects require explicit user approval.

Never include credentials, production records, private notes, session files, database dumps or operational screenshots in an issue, fixture or commit. Use reserved example domains and fabricated data. Report vulnerabilities privately under [SECURITY.md](SECURITY.md).

Maintainers may request changes or defer a proposal outside the current scope. No response-time or release schedule is promised. Contributions to original code are submitted under the project's MIT license; retain upstream notices for any third-party material you add.
