package scratchpad

import (
	"context"
	"time"
	"unicode/utf8"
)

const (
	ReceiptRetention = 7 * 24 * time.Hour
	ReceiptLimit     = 1000
)

type Service struct {
	store Store
	now   func() time.Time
}

type ServiceOption func(*Service)

func WithClock(now func() time.Time) ServiceOption {
	return func(service *Service) { service.now = now }
}

func NewService(store Store, options ...ServiceOption) *Service {
	service := &Service{store: store, now: time.Now}
	for _, option := range options {
		option(service)
	}
	return service
}

func (service *Service) Bootstrap(ctx context.Context) (State, error) {
	return service.store.Bootstrap(ctx)
}

func (service *Service) Save(ctx context.Context, command SaveCommand) (SaveResult, error) {
	if err := validateID(command.ScratchpadID); err != nil {
		return SaveResult{}, err
	}
	if err := validateID(command.ClientID); err != nil {
		return SaveResult{}, err
	}
	if err := validateID(command.SessionID); err != nil {
		return SaveResult{}, err
	}
	if err := validateID(command.MutationID); err != nil {
		return SaveResult{}, err
	}
	if err := validateRevision(command.BaseRevision); err != nil {
		return SaveResult{}, err
	}
	normalized, err := NormalizeContent(command.Content)
	if err != nil {
		return SaveResult{}, err
	}
	command.Content = normalized
	return service.store.Save(ctx, command)
}

func (service *Service) ListConflicts(ctx context.Context, filter ConflictFilter) ([]Conflict, error) {
	if (filter.ClientID == "") != (filter.SessionID == "") {
		return nil, &Error{Code: ErrorInvalidState, Message: "client and session identifiers must be supplied together"}
	}
	if filter.ClientID != "" {
		if err := validateID(filter.ClientID); err != nil {
			return nil, err
		}
		if err := validateID(filter.SessionID); err != nil {
			return nil, err
		}
	}
	return service.store.ListConflicts(ctx, filter)
}

func (service *Service) ResolveConflict(ctx context.Context, command ResolveCommand) (ResolveResult, error) {
	if err := validateID(command.ConflictID); err != nil {
		return ResolveResult{}, err
	}
	if err := validateRevision(command.BaseRevision); err != nil {
		return ResolveResult{}, err
	}
	normalized, err := NormalizeContent(command.Content)
	if err != nil {
		return ResolveResult{}, err
	}
	command.Content = normalized
	return service.store.ResolveConflict(ctx, command)
}

func (service *Service) PruneReceipts(ctx context.Context) (int64, error) {
	return service.store.PruneReceipts(ctx, service.now().UTC().Add(-ReceiptRetention), ReceiptLimit)
}

func validateID(value string) error {
	if value == "" || len(value) > 128 || !utf8.ValidString(value) {
		return &Error{Code: ErrorInvalidState, Message: "identifier must contain 1 to 128 UTF-8 bytes"}
	}
	return nil
}

func validateRevision(value int64) error {
	if value < 0 || value > MaxRevision {
		return &Error{Code: ErrorInvalidState, Message: "revision must be a non-negative safe integer"}
	}
	return nil
}
