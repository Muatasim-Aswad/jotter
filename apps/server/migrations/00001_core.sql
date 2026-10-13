-- +goose Up
CREATE TABLE scratchpads (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
    content TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE conflicts (
    conflict_id TEXT PRIMARY KEY NOT NULL CHECK (length(conflict_id) BETWEEN 1 AND 128),
    scratchpad_id TEXT NOT NULL REFERENCES scratchpads(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
    submitted_content TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0 AND base_revision <= 9007199254740991),
    server_content TEXT NOT NULL,
    server_revision INTEGER NOT NULL CHECK (server_revision >= 0 AND server_revision <= 9007199254740991),
    client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 128),
    session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
    created_at TEXT NOT NULL,
    UNIQUE (mutation_id)
);

CREATE INDEX conflicts_scratchpad_created_idx
    ON conflicts (scratchpad_id, created_at, conflict_id);
CREATE INDEX conflicts_origin_idx
    ON conflicts (scratchpad_id, client_id, session_id, created_at, conflict_id);

CREATE TABLE mutation_receipts (
    scratchpad_id TEXT NOT NULL REFERENCES scratchpads(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
    accepted_revision INTEGER NOT NULL CHECK (accepted_revision >= 0 AND accepted_revision <= 9007199254740991),
    created_at TEXT NOT NULL,
    PRIMARY KEY (mutation_id)
);

CREATE INDEX mutation_receipts_prune_idx
    ON mutation_receipts (scratchpad_id, accepted_revision DESC);
CREATE INDEX mutation_receipts_age_idx
    ON mutation_receipts (created_at);

-- +goose Down
DROP TABLE mutation_receipts;
DROP TABLE conflicts;
DROP TABLE scratchpads;
