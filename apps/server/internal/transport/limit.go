package transport

import (
	"sync"
	"time"
)

type RateLimit struct {
	mu                  sync.Mutex
	rate, burst, tokens float64
	last                time.Time
}

func NewRateLimit(rate, burst float64) *RateLimit {
	return &RateLimit{rate: rate, burst: burst, tokens: burst}
}

func (limit *RateLimit) Allow(now time.Time) bool {
	limit.mu.Lock()
	defer limit.mu.Unlock()
	if !limit.last.IsZero() && now.After(limit.last) {
		limit.tokens = min(limit.burst, limit.tokens+now.Sub(limit.last).Seconds()*limit.rate)
	}
	limit.last = now
	if limit.tokens < 1 {
		return false
	}
	limit.tokens--
	return true
}
