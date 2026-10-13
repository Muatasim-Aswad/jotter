package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/config"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
	sqlitestore "github.com/Muatasim-Aswad/jotter/apps/server/internal/storage/sqlite"
	httptransport "github.com/Muatasim-Aswad/jotter/apps/server/internal/transport/http"
	wstransport "github.com/Muatasim-Aswad/jotter/apps/server/internal/transport/ws"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/webassets"
	"github.com/pressly/goose/v3"
)

func main() {
	configureLogger("info")
	if err := run(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	assets, err := webassets.FS()
	if err != nil {
		return err
	}
	identity, identityErr := webassets.Identity(assets)
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "version" || os.Args[1] == "build-info") {
		if identityErr != nil {
			return identityErr
		}
		if os.Args[1] == "build-info" {
			return json.NewEncoder(os.Stdout).Encode(identity)
		}
		fmt.Printf("Jotter %s %s\n", *identity.Version, identity.Revision)
		return nil
	}

	if len(os.Args) > 1 {
		if len(os.Args) != 3 || os.Args[1] != "verify-data" {
			return errors.New("usage: jotter [--version | version | build-info | verify-data <copy-directory>]")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := sqlitestore.VerifyCopy(ctx, filepath.Join(os.Args[2], "jotter.db")); err != nil {
			return err
		}
		slog.Info("SQLite copy verified")
		return nil
	}
	if identityErr != nil {
		return identityErr
	}
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		return err
	}
	configureLogger(settings.LogLevel)
	if settings.AuthDisabled {
		slog.Warn("authentication is disabled; access control is delegated to the deployment boundary")
	}
	syscall.Umask(0o077)
	if err := os.MkdirAll(settings.DataDir, 0o700); err != nil {
		return err
	}
	goose.SetLogger(goose.NopLogger())
	store, err := sqlitestore.Open(context.Background(), filepath.Join(settings.DataDir, "jotter.db"))
	if err != nil {
		return err
	}
	defer store.Close()
	slog.Info("database migrations applied")
	service := scratchpad.NewService(store)
	if _, err := service.Bootstrap(context.Background()); err != nil {
		return err
	}

	mux := http.NewServeMux()
	health := httptransport.NewHealth(store.Ready)
	health.Register(mux)
	hub := wstransport.NewHub()
	websocketController, err := wstransport.New(service, hub, settings.PublicOrigin)
	if err != nil {
		return err
	}
	defer websocketController.Close("server stopped")
	websocketController.Register(mux)
	httptransport.NewAPI(service, hub).Register(mux)
	mux.Handle("/", webassets.Handler(assets))
	handler, err := httptransport.Security(settings.PublicOrigin, mux)
	if err != nil {
		return err
	}
	handler = httptransport.Boundary(handler)

	server := &http.Server{
		Addr:              settings.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
		ErrorLog:          slog.NewLogLogger(slog.Default().Handler(), slog.LevelError),
	}
	health.SetReady(true)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)

	result := make(chan error, 1)
	go func() { result <- server.ListenAndServe() }()
	slog.Info("server started", "address", settings.ListenAddr, "environment", settings.Environment, "version", *identity.Version, "revision", identity.Revision, "committedAt", identity.CommittedAt, "builtAt", identity.BuiltAt)

	select {
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			slog.Info("server stopped cleanly")
			return nil
		}
		return err
	case signal := <-stop:
		slog.Info("shutdown requested", "signal", signal.String())
		health.SetReady(false)
		websocketController.Close("server restarting")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			return err
		}
		slog.Info("server stopped cleanly")
		return nil
	}
}

func configureLogger(levelName string) {
	level := slog.LevelInfo
	switch levelName {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	slog.SetDefault(slog.New(handler))
}
