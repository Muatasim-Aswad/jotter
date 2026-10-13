package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
)

// VerifyCopy checks an offline staging copy without migrating or changing its data.
func VerifyCopy(ctx context.Context, path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return errors.New("cannot resolve SQLite copy")
	}
	owner, err := os.OpenFile(absolute+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return errors.New("cannot lock SQLite copy")
	}
	defer owner.Close()
	if syscall.Flock(int(owner.Fd()), syscall.LOCK_SH|syscall.LOCK_NB) != nil {
		return errors.New("SQLite copy is in use; stop its owner before verification")
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String() + "?mode=ro&_pragma=query_only(1)&_pragma=busy_timeout(1000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return errors.New("cannot open SQLite copy")
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	rows, err := db.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return errors.New("SQLite copy integrity check failed")
	}
	valid := true
	count := 0
	for rows.Next() {
		var result string
		if rows.Scan(&result) != nil || result != "ok" {
			valid = false
		}
		count++
	}
	if rows.Err() != nil {
		valid = false
	}
	_ = rows.Close()
	if !valid || count != 1 {
		return errors.New("SQLite copy integrity check failed")
	}
	rows, err = db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return errors.New("SQLite copy foreign key check failed")
	}
	invalid := rows.Next()
	err = rows.Err()
	_ = rows.Close()
	if invalid || err != nil {
		return errors.New("SQLite copy foreign key check failed")
	}
	var version int
	if db.QueryRowContext(ctx, "SELECT max(version_id) FROM goose_db_version WHERE is_applied = 1").Scan(&version) != nil || version < 1 || version > 2 {
		return errors.New("SQLite copy has an unsupported Jotter schema")
	}
	for _, query := range []string{
		"SELECT id, content, revision, created_at, updated_at FROM scratchpads LIMIT 0",
		"SELECT conflict_id, scratchpad_id, mutation_id, submitted_content, server_content FROM conflicts LIMIT 0",
		"SELECT scratchpad_id, mutation_id, accepted_revision, created_at FROM mutation_receipts LIMIT 0",
	} {
		rows, err := db.QueryContext(ctx, query)
		if err != nil {
			return errors.New("SQLite copy is missing Jotter data tables")
		}
		_ = rows.Close()
	}
	return nil
}
