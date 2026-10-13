# Full revisions with explicit conflicts

Synchronize complete document snapshots under revision preconditions and stable mutation identities. This makes a single scratchpad’s commit, retry, and recovery behavior inspectable, while stale edits preserve both versions for user review. The trade-off is snapshot bandwidth and manual reconciliation instead of operation-based CRDT merging; changing this choice would alter the protocol and durable outbox semantics.
