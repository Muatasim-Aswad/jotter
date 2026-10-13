package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

const (
	Development = "development"
	Production  = "production"
)

type Config struct {
	Environment  string
	ListenAddr   string
	PublicOrigin string
	DataDir      string
	LogLevel     string
	AuthDisabled bool
}

type LookupEnv func(string) (string, bool)

func Load(lookup LookupEnv) (Config, error) {
	environment := value(lookup, "JOTTER_ENV", Development)
	publicOrigin, publicOriginSet := lookup("JOTTER_PUBLIC_ORIGIN")
	if !publicOriginSet {
		if environment == Production {
			return Config{}, fmt.Errorf("production startup requires explicit JOTTER_PUBLIC_ORIGIN")
		}
		publicOrigin = "http://127.0.0.1:5173"
	}
	authDisabled, authDisabledSet := lookup("AUTH_DISABLED")
	if environment == Production && (!authDisabledSet || authDisabled != "true") {
		return Config{}, fmt.Errorf("production startup requires explicit AUTH_DISABLED=true")
	}
	config := Config{
		Environment:  environment,
		ListenAddr:   value(lookup, "JOTTER_LISTEN_ADDR", "127.0.0.1:8080"),
		PublicOrigin: publicOrigin,
		DataDir:      value(lookup, "JOTTER_DATA_DIR", "./data"),
		LogLevel:     value(lookup, "JOTTER_LOG_LEVEL", "info"),
		AuthDisabled: authDisabledSet && authDisabled == "true",
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config Config) Validate() error {
	if config.Environment != Development && config.Environment != Production {
		return fmt.Errorf("JOTTER_ENV must be %q or %q", Development, Production)
	}
	if _, _, err := net.SplitHostPort(config.ListenAddr); err != nil {
		return fmt.Errorf("JOTTER_LISTEN_ADDR must contain a valid host and port: %w", err)
	}
	origin, err := url.Parse(config.PublicOrigin)
	if err != nil || strings.TrimSpace(config.PublicOrigin) != config.PublicOrigin || origin.Host == "" || origin.Hostname() == "" || (origin.Scheme != "http" && origin.Scheme != "https") || origin.User != nil || origin.Path != "" || origin.RawPath != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.Opaque != "" {
		return fmt.Errorf("JOTTER_PUBLIC_ORIGIN must be an HTTP(S) origin without a path")
	}
	if config.Environment == Production {
		if origin.Scheme != "https" {
			return fmt.Errorf("production JOTTER_PUBLIC_ORIGIN must use HTTPS")
		}
	}
	if strings.TrimSpace(config.DataDir) == "" {
		return fmt.Errorf("JOTTER_DATA_DIR must not be empty")
	}
	switch config.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("JOTTER_LOG_LEVEL must be debug, info, warn, or error")
	}
	return nil
}

func value(lookup LookupEnv, key, fallback string) string {
	if result, ok := lookup(key); ok {
		return result
	}
	return fallback
}
