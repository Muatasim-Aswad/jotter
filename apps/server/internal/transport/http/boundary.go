package httptransport

import (
	"bufio"
	"crypto/rand"
	"log/slog"
	"net"
	"net/http"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/transport"
)

func Boundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		id := rand.Text()
		response.Header().Set("X-Request-ID", id)
		writer := &boundaryWriter{ResponseWriter: response}
		request = request.WithContext(transport.WithRequestID(request.Context(), id))
		defer func() {
			if recovered := recover(); recovered != nil {
				if writer.committed {
					slog.Error("request aborted", "request_id", id, "code", "internal_error")
					panic(http.ErrAbortHandler)
				}
				writeError(writer, http.StatusInternalServerError, "internal_error", "request could not be completed")
			}
			if writer.failureCode != "" {
				level := slog.LevelWarn
				if writer.status >= http.StatusInternalServerError {
					level = slog.LevelError
				}
				slog.Log(request.Context(), level, "request failed", "request_id", id, "code", writer.failureCode, "status", writer.status)
			}
		}()
		next.ServeHTTP(writer, request)
	})
}

type boundaryWriter struct {
	http.ResponseWriter
	status      int
	committed   bool
	fallback    bool
	failureCode string
}

func (writer *boundaryWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *boundaryWriter) WriteHeader(status int) {
	if writer.committed {
		return
	}
	writer.status, writer.committed = status, true
	if status >= http.StatusBadRequest && writer.Header().Get("Content-Type") != "application/json" {
		writer.fallback = true
		code, message := routingError(status)
		writer.failureCode = code
		writeError(writer.ResponseWriter, status, code, message)
		return
	}
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *boundaryWriter) Write(data []byte) (int, error) {
	if !writer.committed {
		writer.WriteHeader(http.StatusOK)
	}
	if writer.fallback {
		return len(data), nil
	}
	return writer.ResponseWriter.Write(data)
}

func (writer *boundaryWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := http.NewResponseController(writer.ResponseWriter).Hijack()
	if err == nil {
		writer.committed, writer.status = true, http.StatusSwitchingProtocols
	}
	return connection, buffer, err
}

func routingError(status int) (string, string) {
	switch status {
	case http.StatusNotFound:
		return "not_found", "resource does not exist"
	case http.StatusMethodNotAllowed:
		return "method_not_allowed", "request method is not allowed"
	case http.StatusForbidden:
		return "invalid_origin", "request origin is not allowed"
	case http.StatusRequestEntityTooLarge:
		return "request_too_large", "request body is too large"
	default:
		return "internal_error", "request could not be completed"
	}
}
