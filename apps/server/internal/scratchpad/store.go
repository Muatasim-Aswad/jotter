package scratchpad

import (
	"context"
	"time"
)

// Store owns the transaction boundaries needed by the service. Implementations
// must not return an accepted or conflicted result until its transaction commits.
type Store interface {
	Bootstrap(context.Context) (State, error)
	Save(context.Context, SaveCommand) (SaveResult, error)
	ListConflicts(context.Context, ConflictFilter) ([]Conflict, error)
	ResolveConflict(context.Context, ResolveCommand) (ResolveResult, error)
	PruneReceipts(context.Context, time.Time, int) (int64, error)
}
