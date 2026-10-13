package transport

import (
	"testing"
	"time"
)

func TestRateLimitBurstRefillAndCap(t *testing.T) {
	now := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	limit := NewRateLimit(2, 3)
	for range 3 {
		if !limit.Allow(now) {
			t.Fatal("burst rejected")
		}
	}
	if limit.Allow(now) || limit.Allow(now.Add(499*time.Millisecond)) {
		t.Fatal("over limit allowed")
	}
	if !limit.Allow(now.Add(500 * time.Millisecond)) {
		t.Fatal("refill rejected")
	}
	for range 3 {
		if !limit.Allow(now.Add(time.Hour)) {
			t.Fatal("refilled burst rejected")
		}
	}
	if limit.Allow(now.Add(time.Hour)) {
		t.Fatal("refill exceeded burst")
	}
}
