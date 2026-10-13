package httptransport

import (
	"fmt"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/transport"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Security wraps every application route with the browser and request-boundary policy.
func Security(publicOrigin string, next http.Handler) (http.Handler, error) {
	origin, err := url.Parse(publicOrigin)
	if err != nil || origin.Scheme == "" || origin.Host == "" {
		return nil, fmt.Errorf("public origin is invalid")
	}
	allowedOrigin := origin.Scheme + "://" + origin.Host
	secureOrigin := origin.Scheme == "https"

	requests := make(chan struct{}, 32)
	connections := make(chan struct{}, 16)
	limit := transport.NewRateLimit(64, 128)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		setSecurityHeaders(response.Header(), secureOrigin)
		host := strings.ToLower(request.Host)
		hostname := host
		if parsed, _, err := net.SplitHostPort(host); err == nil {
			hostname = parsed
		}
		local := hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1"
		if host != strings.ToLower(origin.Host) && !local {
			writeError(response, http.StatusForbidden, "invalid_origin", "request host is not allowed")
			return
		}
		if requestOrigin := request.Header.Get("Origin"); requestOrigin != "" && requestOrigin != allowedOrigin {
			writeError(response, http.StatusForbidden, "invalid_origin", "request origin is not allowed")
			return
		}
		if request.ContentLength > maxJSONBodyBytes {
			writeError(response, http.StatusRequestEntityTooLarge, "request_too_large", "request body is too large")
			return
		}
		if request.Body != nil {
			request.Body = http.MaxBytesReader(response, request.Body, maxJSONBodyBytes)
		}
		if request.URL.Path != "/health/live" && request.URL.Path != "/health/ready" {
			if !limit.Allow(time.Now()) {
				rejectBusy(response)
				return
			}
			capacity := requests
			if request.URL.Path == "/ws" {
				capacity = connections
			}
			select {
			case capacity <- struct{}{}:
				defer func() { <-capacity }()
			default:
				rejectBusy(response)
				return
			}
		}
		next.ServeHTTP(response, request)
	}), nil
}

func setSecurityHeaders(header http.Header, secureOrigin bool) {
	header.Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'")
	header.Set("Cross-Origin-Opener-Policy", "same-origin")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
	if secureOrigin {
		header.Set("Strict-Transport-Security", "max-age=31536000")
	}
}

func rejectBusy(response http.ResponseWriter) {
	response.Header().Set("Retry-After", "1")
	writeError(response, http.StatusTooManyRequests, "too_many_requests", "request capacity exceeded; retry later")
}
