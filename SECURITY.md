# Security policy

Grove is early-stage software. Security fixes target the current default branch; older snapshots do not have a support guarantee.

## Report privately

Use this repository's **Security → Report a vulnerability** option when available. Do not put vulnerability details, exploit payloads, credentials or private records in a public issue. If private reporting is unavailable, open an issue titled “Private security contact requested” containing no technical or personal details; wait for a maintainer to arrange a private channel before sharing the report.

Include affected versions, impact, a minimal reproduction using synthetic data and suggested mitigations. Maintainers will coordinate validation and disclosure; no response SLA is promised. Do not test systems or accounts you do not own or have permission to assess.

## Boundaries

Treat provider output and imported content as untrusted. Preserve account/workspace isolation, scoped tokens, private-file authorization, outbound request restrictions and snapshot approval. Keep environment files, private uploads, database dumps and browser sessions out of Git and issue attachments.

See [self-hosting](docs/self-hosting.md) for deployment responsibilities. Tests and access controls are not a claim of an independent security certification.
