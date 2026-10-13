# One process owns local SQLite

Use one Go process, an exclusive ownership lock, and a SQLite database on local disk; apply forward migrations before readiness while ownership is held. This keeps transactions and deployment simple for a private local application, at the cost of ruling out replicas and network filesystems. Scaling to independently deployed services would require a different persistence and migration boundary.
