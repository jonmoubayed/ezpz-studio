# Security policy

## Supported scope

The current beta is intended for one user on a trusted local machine. The packaged service binds to loopback and has no application authentication. Do not expose it directly to the internet or use it as a shared multi-user service.

Keep provider credentials in the backend environment. Documents and annotations are private workspace data; exclude them from public issues, screenshots, and source commits. Hosted providers receive the content required by the model or parser you select.

## Report a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/jonmoubayed/ezpz-studio/security/advisories/new) for security issues. Include the affected version, a minimal synthetic reproduction, expected and observed behavior, and any relevant redacted logs.

Do not open a public issue containing an exploit, credentials, or private documents. If private reporting is unavailable, request a private contact through a minimal issue without disclosing vulnerability details.

## Updates

Security fixes target the latest beta. Back up the database and blobs together before upgrading; follow the [deployment guide](docs/deployment.md). Automated tests and dependency checks reduce risk but do not constitute a comprehensive security audit.
