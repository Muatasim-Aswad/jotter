package migrations

import "embed"

// FS contains the ordered, forward-only database migrations.
//
//go:embed *.sql
var FS embed.FS
