# Limitations

Jotter V1 deliberately optimizes for one private scratchpad and a small trusted deployment.

- There is no application authentication, authorization, registration, role model, OAuth, password reset, or public sharing. A trusted private access boundary is mandatory.
- One Go process owns one SQLite file on local storage. Multiple replicas, network filesystems, and active-active operation are unsupported.
- There is one visible scratchpad and one owner. Additional scratchpads, users, read-only shares, public endpoints, and terminal/native clients are deferred.
- There is no history, restore UI, trash, clear/delete action, automatic merge, CRDT, operation log, or last-write-wins behavior. Conflicts require an explicit choice.
- The current accepted content cannot be recovered after an intentional or accidental edit, an empty edit, SQLite corruption, loss of the server disk, or browser storage eviction. Manual consistent pre-upgrade copies are required; automated and off-server backups are deferred.
- Mutation receipts and unresolved conflicts are correctness state, not user-visible history. Receipts are bounded to 1,000 per scratchpad and seven days.
- Browser support is current Chrome on Android and desktop. Safari, Firefox, native apps, widgets, and terminal clients are not release targets.
- Opening the editor restores its cursor and requests focus and the virtual keyboard on every device. Browser interaction requirements can still keep the keyboard closed until a tap; keyboard visibility requires real-device verification.
- Background Sync is not used for correctness. Pending work synchronizes while the foreground app is open and connectivity returns.
- Remote updates do not promise to preserve the browser's native undo stack. Cursor, selection, and scroll position are device-local and never synchronized.
- Real Android share-sheet registration, virtual-keyboard layout, home-network propagation, private HTTPS, and two-device behavior require manual release-gate verification.
- There is no telemetry, analytics, external monitoring, Watchtower, or unattended server update path. Published containers are available through GHCR; operators choose upgrades.
- Rollback changes only the local image and is safe only while the migrated schema remains compatible. Automatic down-migration is not supported.

Published binaries and containers support Linux amd64 only. Other targets are untested.

The architecture preserves stable scratchpad identity and clear package boundaries so deferred authentication, recovery snapshots, a small number of additional scratchpads, and additional clients can be added without replacing the V1 core.

## Data, network, and retention

At runtime the browser contacts only its configured Jotter origin for the app, API, WebSocket, health, and build checks. It sends note text, shared text/links, mutation identities, and conflict choices to that server; it does not fetch links pasted into notes. There are no analytics or third-party runtime services. The private access proxy may keep its own access logs; the operator controls that policy. Installation and upgrades contact GitHub/GHCR and the package/tool registries; those are separate from note synchronization.

SQLite retains current accepted text and unresolved conflicts containing both versions until resolution. Content-free mutation receipts expire after seven days or beyond the newest 1,000 per scratchpad. The app has no historical-note archive. Server lifecycle/outcome logs contain no note bodies; Compose rotates three 10 MiB log files. Operators control other log and backup retention.

Browser IndexedDB retains cached accepted text, installation identity, drafts/outboxes, conflicts, and share-inbox records (including consumed shares). Consumed share records retain their payload until site data is cleared; there is no automatic expiry. Session storage identifies tabs; local storage remembers the last noticed build; the service worker caches static assets. Pending work stays until an acknowledged save or preserved conflict establishes its outcome. Browser replicas and backups can retain older text indefinitely until cleared, and browser eviction can lose unsent work.

## Safe deletion

Before clearing browser/site data, uninstalling the PWA, or deleting server data, reconnect every device and open every tab to synchronize. Resolve conflicts and recover orphan drafts; copy any unsent text or conflict versions you need into a protected location. If synchronization fails, preserve those copies before proceeding. Clearing site data discards pending edits, shares, and recovery state; it is not a safe troubleshooting shortcut.

To empty the scratchpad, replace its text with an empty edit and let it synchronize. This does not erase unresolved conflicts, backups, other browser copies, or SQLite disk remnants. For complete removal, stop access and the server, preserve anything still needed, remove the entire configured data directory including SQLite sidecars, clear Jotter site data and cached assets on every browser/profile, and delete retained backups and copies under your storage policy. Do not remove files from a running database or leave old offline clients able to reconnect and restore text. The app provides no secure-erasure guarantee; disk encryption and media disposal belong to the operator.
