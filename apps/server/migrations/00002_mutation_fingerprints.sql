-- +goose Up
ALTER TABLE mutation_receipts ADD COLUMN request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64);

-- +goose Down
ALTER TABLE mutation_receipts DROP COLUMN request_hash;
