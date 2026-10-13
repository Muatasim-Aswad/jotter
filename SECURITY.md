# Security

Jotter supports one owner behind a trusted private HTTPS access boundary. It has no application authentication or authorization. `AUTH_DISABLED=true` acknowledges that requirement; host/origin checks and CSP do not replace access control. See [deployment](docs/deployment.md) and [data handling and limitations](docs/limitations.md).

## Supported versions

Before the first release, security fixes target `main`. After launch, only the latest release receives best-effort security support; there is no response-time or long-term support guarantee. Verify upgrades and retain a verified backup.

## Report a vulnerability

Report privately with [GitHub private vulnerability reporting](https://github.com/Muatasim-Aswad/jotter/security/advisories/new). If it is unavailable, open a minimal [issue](https://github.com/Muatasim-Aswad/jotter/issues/new/choose) requesting a private reporting route; include no vulnerability, exploit, deployment, or personal details. Wait for a private channel before providing them. Do not post security details in Discussions or public issues.

Store SQLite on local disk with owner-only permissions. Treat backups and browser profiles as private copies of the notes. Document text, shares, conflict bodies, credentials, and private host details must not appear in logs, reports, or attachments.
