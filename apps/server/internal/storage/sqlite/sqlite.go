package sqlite

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
	"github.com/Muatasim-Aswad/jotter/apps/server/migrations"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

var migrationMu sync.Mutex

type Store struct {
	db        *sql.DB
	owner     *os.File
	closeOnce sync.Once
	closeErr  error
	now       func() time.Time
	newID     func() (string, error)
}

type Option func(*Store)

func WithClock(now func() time.Time) Option {
	return func(store *Store) { store.now = now }
}

func WithIDGenerator(generator func() (string, error)) Option {
	return func(store *Store) { store.newID = generator }
}

func Open(ctx context.Context, path string, options ...Option) (*Store, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve sqlite path: %w", err)
	}
	owner, err := os.OpenFile(absolute+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open database ownership lock: %w", err)
	}
	if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = owner.Close()
		return nil, fmt.Errorf("database already owned by another process: %w", err)
	}
	opened := false
	defer func() {
		if !opened {
			_ = owner.Close()
		}
	}()
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
	dsn += "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("connect sqlite: %w", err)
	}

	store := &Store{db: db, owner: owner, now: time.Now, newID: randomUUID}
	for _, option := range options {
		option(store)
	}
	if err := migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	opened = true
	return store, nil
}

func (store *Store) Close() error {
	store.closeOnce.Do(func() {
		store.closeErr = store.db.Close()
		if err := store.owner.Close(); store.closeErr == nil {
			store.closeErr = err
		}
	})
	return store.closeErr
}

func (store *Store) Ready(ctx context.Context) error {
	if err := store.db.PingContext(ctx); err != nil {
		return storageError("check storage readiness", err)
	}
	return nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	migrationMu.Lock()
	defer migrationMu.Unlock()
	goose.SetBaseFS(migrations.FS)
	defer goose.SetBaseFS(nil)
	if err := goose.SetDialect("sqlite3"); err != nil {
		return fmt.Errorf("configure migrations: %w", err)
	}
	if err := goose.UpContext(ctx, db, "."); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

func randomUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func storageError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return &scratchpad.Error{Code: scratchpad.ErrorStorageUnavailable, Message: "storage unavailable", Cause: fmt.Errorf("%s: %w", operation, err)}
}
