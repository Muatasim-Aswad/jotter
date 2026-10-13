# Contributing

Jotter is one minimal private scratchpad for writing quickly across devices. Discuss changes that expand that scope in [Discussions](https://github.com/Muatasim-Aswad/jotter/discussions) before implementation; use Discussions for questions too.

Fork the repository, clone your fork, and create a focused branch. Follow the [development setup](docs/development.md), install hooks with `mise run hooks:install`, and run `mise run verify` before opening a pull request against `main`. CI runs the same gate; Docker, Chromium libraries, and Python 3.11+ are required.

Describe the behavior before and after, relevant tests and checks run, privacy or network changes, and migration, pending-draft compatibility, and rollback implications. Mark irrelevant items as not applicable; explain omitted checks. Use synthetic fixtures and screenshots and remove private notes, host details, credentials, and personal data from reports and traces.

Pull requests require a CODEOWNER approval, an up-to-date branch, and passing CI and CodeQL. Authors cannot approve their own changes; a solo maintainer may deliberately use the documented admin bypass for a maintainer-authored pull request after all checks pass. Enable auto-merge only after review; it must wait for required approvals and checks. Changes merge by squash using the pull request title and body.

Keep domain rules independent of transport and persistence. Compose adapters in entrypoints and test durable behavior with disposable SQLite databases. Keep editor recovery logic testable through injected dependencies.

Edit wire contracts in `packages/protocol/openapi.json`, run `mise run contracts:generate`, and add shared fixtures for new cross-language rules. Do not edit generated contracts or compiled assets by hand. Add forward migrations for schema changes and preserve pending browser drafts.

Use focused commits. Conventional Commits are optional. Document consequential trade-offs in `docs/adr/` and ambiguous terms in `CONTEXT.md`. Root `package.json` owns the product version; workspace versions must agree. Keep personal plans, deployment records, databases, and credentials outside tracked files.
