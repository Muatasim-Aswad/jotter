package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
)

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (store *Store) Bootstrap(ctx context.Context) (scratchpad.State, error) {
	tx, err := store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return scratchpad.State{}, storageError("begin bootstrap", err)
	}
	defer func() { _ = tx.Rollback() }()

	state, err := loadSingleton(ctx, tx)
	if errors.Is(err, sql.ErrNoRows) {
		id, idErr := store.newID()
		if idErr != nil {
			return scratchpad.State{}, storageError("generate scratchpad identifier", idErr)
		}
		now := store.now().UTC()
		_, err = tx.ExecContext(ctx, `INSERT INTO scratchpads (id, content, revision, created_at, updated_at) VALUES (?, '', 0, ?, ?)`, id, formatTime(now), formatTime(now))
		if err != nil {
			return scratchpad.State{}, storageError("create singleton scratchpad", err)
		}
		state = scratchpad.Scratchpad{ID: id, CreatedAt: now, UpdatedAt: now}
	} else if err != nil {
		return scratchpad.State{}, storageError("load singleton scratchpad", err)
	}
	conflicts, err := listConflicts(ctx, tx, state.ID, scratchpad.ConflictFilter{})
	if err != nil {
		return scratchpad.State{}, storageError("load bootstrap conflicts", err)
	}
	if err := tx.Commit(); err != nil {
		return scratchpad.State{}, storageError("commit bootstrap", err)
	}
	return scratchpad.State{Scratchpad: state, Conflicts: conflicts}, nil
}

func (store *Store) Save(ctx context.Context, command scratchpad.SaveCommand) (scratchpad.SaveResult, error) {
	tx, err := store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return scratchpad.SaveResult{}, storageError("begin save", err)
	}
	defer func() { _ = tx.Rollback() }()

	if receipt, hash, found, err := findReceipt(ctx, tx, command.MutationID); err != nil {
		return scratchpad.SaveResult{}, storageError("lookup mutation receipt", err)
	} else if found {
		if hash != requestHash(command) {
			return scratchpad.SaveResult{}, mutationMismatch()
		}
		current, err := loadScratchpad(ctx, tx, command.ScratchpadID)
		if err != nil {
			return scratchpad.SaveResult{}, storageError("load retry state", err)
		}
		if err := tx.Commit(); err != nil {
			return scratchpad.SaveResult{}, storageError("commit receipt lookup", err)
		}
		return scratchpad.SaveResult{Kind: scratchpad.SaveAccepted, Receipt: &receipt, Scratchpad: &current}, nil
	}

	if conflict, found, err := findConflictByMutation(ctx, tx, command.MutationID); err != nil {
		return scratchpad.SaveResult{}, storageError("lookup mutation conflict", err)
	} else if found {
		original := scratchpad.SaveCommand{ScratchpadID: conflict.ScratchpadID, MutationID: conflict.MutationID, Content: conflict.SubmittedContent, BaseRevision: conflict.BaseRevision, ClientID: conflict.ClientID, SessionID: conflict.SessionID}
		if requestHash(command) != requestHash(original) {
			return scratchpad.SaveResult{}, mutationMismatch()
		}
		if err := tx.Commit(); err != nil {
			return scratchpad.SaveResult{}, storageError("commit conflict lookup", err)
		}
		return scratchpad.SaveResult{Kind: scratchpad.SaveConflicted, Conflict: &conflict}, nil
	}

	current, err := loadScratchpad(ctx, tx, command.ScratchpadID)
	if errors.Is(err, sql.ErrNoRows) {
		return scratchpad.SaveResult{}, &scratchpad.Error{Code: scratchpad.ErrorInvalidState, Message: "scratchpad does not exist"}
	}
	if err != nil {
		return scratchpad.SaveResult{}, storageError("load scratchpad for save", err)
	}
	if command.BaseRevision != current.Revision {
		conflictID, idErr := store.newID()
		if idErr != nil {
			return scratchpad.SaveResult{}, storageError("generate conflict identifier", idErr)
		}
		createdAt := store.now().UTC()
		conflict := scratchpad.Conflict{
			ID: conflictID, ScratchpadID: command.ScratchpadID, MutationID: command.MutationID,
			SubmittedContent: command.Content, BaseRevision: command.BaseRevision,
			ServerContent: current.Content, ServerRevision: current.Revision,
			ClientID: command.ClientID, SessionID: command.SessionID, CreatedAt: createdAt,
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO conflicts (conflict_id, scratchpad_id, mutation_id, submitted_content, base_revision, server_content, server_revision, client_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			conflict.ID, conflict.ScratchpadID, conflict.MutationID, conflict.SubmittedContent, conflict.BaseRevision, conflict.ServerContent, conflict.ServerRevision, conflict.ClientID, conflict.SessionID, formatTime(conflict.CreatedAt))
		if err != nil {
			return scratchpad.SaveResult{}, storageError("preserve stale save", err)
		}
		if err := tx.Commit(); err != nil {
			return scratchpad.SaveResult{}, storageError("commit stale save", err)
		}
		return scratchpad.SaveResult{Kind: scratchpad.SaveConflicted, Conflict: &conflict}, nil
	}

	var unresolved int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM conflicts WHERE scratchpad_id = ? AND client_id = ? AND session_id = ?`, command.ScratchpadID, command.ClientID, command.SessionID).Scan(&unresolved); err != nil {
		return scratchpad.SaveResult{}, storageError("check unresolved conflicts", err)
	}
	if unresolved != 0 {
		return scratchpad.SaveResult{}, &scratchpad.Error{Code: scratchpad.ErrorUnresolvedConflict, Message: "client has an unresolved conflict"}
	}
	if current.Revision == scratchpad.MaxRevision {
		return scratchpad.SaveResult{}, &scratchpad.Error{Code: scratchpad.ErrorInvalidState, Message: "scratchpad revision limit reached"}
	}

	now := store.now().UTC()
	nextRevision := current.Revision + 1
	result, err := tx.ExecContext(ctx, `UPDATE scratchpads SET content = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`, command.Content, nextRevision, formatTime(now), command.ScratchpadID, command.BaseRevision)
	if err != nil {
		return scratchpad.SaveResult{}, storageError("update scratchpad", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return scratchpad.SaveResult{}, storageError("confirm scratchpad update", err)
	}
	if affected != 1 {
		return scratchpad.SaveResult{}, &scratchpad.Error{Code: scratchpad.ErrorStaleRevision, Message: "scratchpad revision changed during save"}
	}
	receipt := scratchpad.MutationReceipt{ScratchpadID: command.ScratchpadID, MutationID: command.MutationID, AcceptedRevision: nextRevision, CreatedAt: now}
	if _, err := tx.ExecContext(ctx, `INSERT INTO mutation_receipts (scratchpad_id, mutation_id, accepted_revision, created_at, request_hash) VALUES (?, ?, ?, ?, ?)`, receipt.ScratchpadID, receipt.MutationID, receipt.AcceptedRevision, formatTime(receipt.CreatedAt), requestHash(command)); err != nil {
		return scratchpad.SaveResult{}, storageError("record mutation receipt", err)
	}
	if _, err := pruneReceiptsTx(ctx, tx, now.Add(-scratchpad.ReceiptRetention), scratchpad.ReceiptLimit); err != nil {
		return scratchpad.SaveResult{}, storageError("prune mutation receipts", err)
	}
	if err := tx.Commit(); err != nil {
		return scratchpad.SaveResult{}, storageError("commit accepted save", err)
	}
	current.Content, current.Revision, current.UpdatedAt = command.Content, nextRevision, now
	return scratchpad.SaveResult{Kind: scratchpad.SaveAccepted, Receipt: &receipt, Scratchpad: &current}, nil
}

func (store *Store) ListConflicts(ctx context.Context, filter scratchpad.ConflictFilter) ([]scratchpad.Conflict, error) {
	state, err := loadSingleton(ctx, store.db)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &scratchpad.Error{Code: scratchpad.ErrorInvalidState, Message: "scratchpad is not initialized"}
	}
	if err != nil {
		return nil, storageError("load singleton scratchpad", err)
	}
	conflicts, err := listConflicts(ctx, store.db, state.ID, filter)
	if err != nil {
		return nil, storageError("list conflicts", err)
	}
	return conflicts, nil
}

func (store *Store) ResolveConflict(ctx context.Context, command scratchpad.ResolveCommand) (scratchpad.ResolveResult, error) {
	tx, err := store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return scratchpad.ResolveResult{}, storageError("begin conflict resolution", err)
	}
	defer func() { _ = tx.Rollback() }()

	conflict, err := loadConflict(ctx, tx, command.ConflictID)
	if errors.Is(err, sql.ErrNoRows) {
		return scratchpad.ResolveResult{}, &scratchpad.Error{Code: scratchpad.ErrorInvalidState, Message: "conflict does not exist"}
	}
	if err != nil {
		return scratchpad.ResolveResult{}, storageError("load conflict", err)
	}
	current, err := loadScratchpad(ctx, tx, conflict.ScratchpadID)
	if err != nil {
		return scratchpad.ResolveResult{}, storageError("load scratchpad for conflict resolution", err)
	}
	if current.Revision != command.BaseRevision {
		return scratchpad.ResolveResult{}, &scratchpad.Error{Code: scratchpad.ErrorStaleRevision, Message: "scratchpad advanced before conflict resolution"}
	}
	if current.Revision == scratchpad.MaxRevision {
		return scratchpad.ResolveResult{}, &scratchpad.Error{Code: scratchpad.ErrorInvalidState, Message: "scratchpad revision limit reached"}
	}

	now := store.now().UTC()
	nextRevision := current.Revision + 1
	result, err := tx.ExecContext(ctx, `UPDATE scratchpads SET content = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`, command.Content, nextRevision, formatTime(now), current.ID, command.BaseRevision)
	if err != nil {
		return scratchpad.ResolveResult{}, storageError("update resolved scratchpad", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return scratchpad.ResolveResult{}, storageError("confirm resolved scratchpad update", err)
	}
	if affected != 1 {
		return scratchpad.ResolveResult{}, &scratchpad.Error{Code: scratchpad.ErrorStaleRevision, Message: "scratchpad advanced before conflict resolution"}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM conflicts WHERE conflict_id = ?`, conflict.ID); err != nil {
		return scratchpad.ResolveResult{}, storageError("delete resolved conflict", err)
	}
	if err := tx.Commit(); err != nil {
		return scratchpad.ResolveResult{}, storageError("commit conflict resolution", err)
	}
	current.Content = command.Content
	current.Revision = nextRevision
	current.UpdatedAt = now
	return scratchpad.ResolveResult{Scratchpad: current}, nil
}

func (store *Store) PruneReceipts(ctx context.Context, before time.Time, limit int) (int64, error) {
	if limit < 1 {
		return 0, &scratchpad.Error{Code: scratchpad.ErrorInvalidState, Message: "receipt limit must be positive"}
	}
	tx, err := store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return 0, storageError("begin receipt pruning", err)
	}
	defer func() { _ = tx.Rollback() }()
	count, err := pruneReceiptsTx(ctx, tx, before.UTC(), limit)
	if err != nil {
		return 0, storageError("prune mutation receipts", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, storageError("commit receipt pruning", err)
	}
	return count, nil
}

func pruneReceiptsTx(ctx context.Context, tx *sql.Tx, before time.Time, limit int) (int64, error) {
	result, err := tx.ExecContext(ctx, `
		DELETE FROM mutation_receipts
		WHERE created_at < ? OR rowid IN (
			SELECT rowid FROM (
				SELECT rowid, ROW_NUMBER() OVER (PARTITION BY scratchpad_id ORDER BY accepted_revision DESC) AS receipt_rank
				FROM mutation_receipts
			) WHERE receipt_rank > ?
		)`, formatTime(before), limit)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func loadSingleton(ctx context.Context, db queryer) (scratchpad.Scratchpad, error) {
	return scanScratchpad(db.QueryRowContext(ctx, `SELECT id, content, revision, created_at, updated_at FROM scratchpads ORDER BY created_at, id LIMIT 1`))
}

func loadScratchpad(ctx context.Context, db queryer, id string) (scratchpad.Scratchpad, error) {
	return scanScratchpad(db.QueryRowContext(ctx, `SELECT id, content, revision, created_at, updated_at FROM scratchpads WHERE id = ?`, id))
}

func scanScratchpad(row *sql.Row) (scratchpad.Scratchpad, error) {
	var value scratchpad.Scratchpad
	var createdAt, updatedAt string
	if err := row.Scan(&value.ID, &value.Content, &value.Revision, &createdAt, &updatedAt); err != nil {
		return scratchpad.Scratchpad{}, err
	}
	var err error
	value.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return scratchpad.Scratchpad{}, err
	}
	value.UpdatedAt, err = parseTime(updatedAt)
	return value, err
}

func findReceipt(ctx context.Context, db queryer, mutationID string) (scratchpad.MutationReceipt, string, bool, error) {
	var receipt scratchpad.MutationReceipt
	var createdAt string
	var hash string
	err := db.QueryRowContext(ctx, `SELECT scratchpad_id, mutation_id, accepted_revision, created_at, COALESCE(request_hash, '') FROM mutation_receipts WHERE mutation_id = ?`, mutationID).Scan(&receipt.ScratchpadID, &receipt.MutationID, &receipt.AcceptedRevision, &createdAt, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return scratchpad.MutationReceipt{}, "", false, nil
	}
	if err != nil {
		return scratchpad.MutationReceipt{}, "", false, err
	}
	receipt.CreatedAt, err = parseTime(createdAt)
	return receipt, hash, true, err
}

func requestHash(command scratchpad.SaveCommand) string {
	data, _ := json.Marshal([]any{"save:v1", command.ScratchpadID, command.ClientID, command.SessionID, command.MutationID, command.BaseRevision, command.Content})
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func mutationMismatch() error {
	return &scratchpad.Error{Code: scratchpad.ErrorMutationMismatch, Message: "mutation identity does not match the original request"}
}

func findConflictByMutation(ctx context.Context, db queryer, mutationID string) (scratchpad.Conflict, bool, error) {
	row := db.QueryRowContext(ctx, conflictSelect+` WHERE mutation_id = ?`, mutationID)
	conflict, err := scanConflict(row)
	if errors.Is(err, sql.ErrNoRows) {
		return scratchpad.Conflict{}, false, nil
	}
	return conflict, err == nil, err
}

func loadConflict(ctx context.Context, db queryer, id string) (scratchpad.Conflict, error) {
	return scanConflict(db.QueryRowContext(ctx, conflictSelect+` WHERE conflict_id = ?`, id))
}

const conflictSelect = `SELECT conflict_id, scratchpad_id, mutation_id, submitted_content, base_revision, server_content, server_revision, client_id, session_id, created_at FROM conflicts`

func scanConflict(row *sql.Row) (scratchpad.Conflict, error) {
	var value scratchpad.Conflict
	var createdAt string
	if err := row.Scan(&value.ID, &value.ScratchpadID, &value.MutationID, &value.SubmittedContent, &value.BaseRevision, &value.ServerContent, &value.ServerRevision, &value.ClientID, &value.SessionID, &createdAt); err != nil {
		return scratchpad.Conflict{}, err
	}
	parsed, err := parseTime(createdAt)
	if err != nil {
		return scratchpad.Conflict{}, err
	}
	value.CreatedAt = parsed
	return value, nil
}

func listConflicts(ctx context.Context, db queryer, scratchpadID string, filter scratchpad.ConflictFilter) ([]scratchpad.Conflict, error) {
	query := conflictSelect + ` WHERE scratchpad_id = ?`
	args := []any{scratchpadID}
	if filter.ClientID != "" {
		query += ` AND client_id = ? AND session_id = ?`
		args = append(args, filter.ClientID, filter.SessionID)
	}
	query += ` ORDER BY created_at, conflict_id`
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]scratchpad.Conflict, 0)
	for rows.Next() {
		var value scratchpad.Conflict
		var createdAt string
		if err := rows.Scan(&value.ID, &value.ScratchpadID, &value.MutationID, &value.SubmittedContent, &value.BaseRevision, &value.ServerContent, &value.ServerRevision, &value.ClientID, &value.SessionID, &createdAt); err != nil {
			return nil, err
		}
		value.CreatedAt, err = parseTime(createdAt)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func parseTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse stored timestamp: %w", err)
	}
	return parsed, nil
}
