package wstransport

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync/atomic"
	"time"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/protocol"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/scratchpad"
	"github.com/Muatasim-Aswad/jotter/apps/server/internal/transport"
	"github.com/coder/websocket"
)

const (
	maxInboundMessageBytes = scratchpad.MaxContentBytes + 16*1024
	handshakeTimeout       = 10 * time.Second
	writeTimeout           = 5 * time.Second
)

type ScratchpadService interface {
	Bootstrap(context.Context) (scratchpad.State, error)
	Save(context.Context, scratchpad.SaveCommand) (scratchpad.SaveResult, error)
	ListConflicts(context.Context, scratchpad.ConflictFilter) ([]scratchpad.Conflict, error)
}

type Controller struct {
	service      ScratchpadService
	hub          *Hub
	publicOrigin string
	nextID       atomic.Uint64
}

func New(service ScratchpadService, hub *Hub, publicOrigin string) (*Controller, error) {
	origin, err := url.Parse(publicOrigin)
	if err != nil || origin.Scheme == "" || origin.Host == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.User != nil {
		return nil, fmt.Errorf("public origin is invalid")
	}
	return &Controller{service: service, hub: hub, publicOrigin: origin.Scheme + "://" + origin.Host}, nil
}

func (controller *Controller) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws", controller.serve)
}

func (controller *Controller) Close(reason string) { controller.hub.Close(reason) }

func (controller *Controller) serve(response http.ResponseWriter, request *http.Request) {
	if request.Header.Get("Origin") != controller.publicOrigin {
		http.Error(response, "origin is not allowed", http.StatusForbidden)
		return
	}
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	connection.SetReadLimit(maxInboundMessageBytes)
	defer connection.CloseNow()

	hello, err := controller.readHello(request.Context(), connection)
	if err != nil {
		controller.writeError(request.Context(), connection, err)
		return
	}
	state, err := controller.service.Bootstrap(request.Context())
	if err != nil {
		controller.writeError(request.Context(), connection, err)
		return
	}
	if hello.ScratchpadID != state.Scratchpad.ID {
		controller.writeError(request.Context(), connection, &scratchpad.Error{Code: scratchpad.ErrorInvalidState, Message: "scratchpad does not exist"})
		return
	}
	conflicts, err := controller.service.ListConflicts(request.Context(), scratchpad.ConflictFilter{ClientID: hello.ClientID, SessionID: hello.SessionID})
	if err != nil {
		controller.writeError(request.Context(), connection, err)
		return
	}
	initial := &protocol.StateEnvelope{V: protocol.Version, Type: "state", Scratchpad: wireScratchpad(state.Scratchpad), Conflicts: wireConflicts(conflicts)}
	if err := writeEnvelope(request.Context(), connection, initial); err != nil {
		return
	}

	id := fmt.Sprintf("connection-%d", controller.nextID.Add(1))
	ctx, cancel := context.WithCancel(request.Context())
	value := &session{
		id: id, clientID: hello.ClientID, sessionID: hello.SessionID,
		outgoing: make(chan []byte, outboundQueueSize), close: connection.Close,
	}
	if !controller.hub.register(value) {
		_ = connection.Close(websocket.StatusGoingAway, "server is stopping")
		cancel()
		return
	}
	slog.Info("websocket connected", "connection_id", id, "request_id", transport.RequestID(ctx))
	defer slog.Info("websocket disconnected", "connection_id", id, "request_id", transport.RequestID(ctx))
	writerDone := make(chan struct{})
	go controller.writeLoop(ctx, cancel, connection, value.outgoing, writerDone)
	controller.readLoop(ctx, connection, value)
	controller.hub.unregister(id)
	cancel()
	connection.CloseNow()
	<-writerDone
}

func (controller *Controller) readHello(parent context.Context, connection *websocket.Conn) (*protocol.HelloEnvelope, error) {
	ctx, cancel := context.WithTimeout(parent, handshakeTimeout)
	defer cancel()
	messageType, data, err := connection.Read(ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageText {
		return nil, &protocol.CodecError{Code: protocol.ErrorInvalidMessage, Msg: "messages must be UTF-8 JSON text"}
	}
	envelope, err := protocol.Decode(data)
	if err != nil {
		return nil, err
	}
	hello, ok := envelope.(*protocol.HelloEnvelope)
	if !ok {
		return nil, &protocol.CodecError{Code: protocol.ErrorInvalidMessage, Msg: "hello must be the first message"}
	}
	return hello, nil
}

func (controller *Controller) readLoop(ctx context.Context, connection *websocket.Conn, value *session) {
	limit := transport.NewRateLimit(20, 40)
	for {
		messageType, data, err := connection.Read(ctx)
		if err != nil {
			return
		}
		if !limit.Allow(time.Now()) {
			_ = connection.Close(websocket.StatusPolicyViolation, "message rate exceeded; reconnect later")
			return
		}
		if messageType != websocket.MessageText {
			controller.sendError(value.id, &protocol.CodecError{Code: protocol.ErrorInvalidMessage, Msg: "messages must be UTF-8 JSON text"}, nil)
			continue
		}
		envelope, err := protocol.Decode(data)
		if err != nil {
			controller.sendError(value.id, err, nil)
			continue
		}
		save, ok := envelope.(*protocol.SaveEnvelope)
		if !ok {
			controller.sendError(value.id, &protocol.CodecError{Code: protocol.ErrorInvalidMessage, Msg: "only save messages are allowed after hello"}, nil)
			continue
		}
		if save.ClientID != value.clientID || save.SessionID != value.sessionID {
			controller.sendError(value.id, &scratchpad.Error{Code: scratchpad.ErrorInvalidState, Message: "connection identity changed"}, &save.MutationID)
			continue
		}
		result, err := controller.service.Save(ctx, scratchpad.SaveCommand{
			ScratchpadID: save.ScratchpadID, Content: save.Content, BaseRevision: save.BaseRevision,
			ClientID: save.ClientID, SessionID: save.SessionID, MutationID: save.MutationID,
		})
		if err != nil {
			slog.Warn("save rejected", "connection_id", value.id, "request_id", transport.RequestID(ctx), "code", errorEnvelope(err, nil).Code)
			controller.sendError(value.id, err, &save.MutationID)
			continue
		}
		switch result.Kind {
		case scratchpad.SaveAccepted:
			if result.Receipt == nil || result.Scratchpad == nil {
				controller.sendError(value.id, errors.New("accepted save has no committed result"), &save.MutationID)
				continue
			}
			ack := &protocol.AckEnvelope{
				V: protocol.Version, Type: "ack", ScratchpadID: result.Receipt.ScratchpadID,
				MutationID: result.Receipt.MutationID, Revision: result.Receipt.AcceptedRevision,
				UpdatedAt: result.Receipt.CreatedAt.UTC().Format(time.RFC3339Nano),
			}
			if !controller.hub.send(value.id, ack) {
				return
			}
			controller.hub.publishExcept(&protocol.UpdateEnvelope{
				V: protocol.Version, Type: "update", Scratchpad: wireScratchpad(*result.Scratchpad), MutationID: save.MutationID,
			}, value.id)
			slog.Info("save committed", "connection_id", value.id, "request_id", transport.RequestID(ctx), "revision", result.Receipt.AcceptedRevision)
		case scratchpad.SaveConflicted:
			if result.Conflict == nil {
				controller.sendError(value.id, errors.New("conflicted save has no conflict"), &save.MutationID)
				continue
			}
			if !controller.hub.send(value.id, wireConflict(*result.Conflict)) {
				return
			}
			slog.Info("save conflicted", "connection_id", value.id, "request_id", transport.RequestID(ctx), "server_revision", result.Conflict.ServerRevision)
		default:
			controller.sendError(value.id, errors.New("save result is invalid"), &save.MutationID)
		}
	}
}

func (controller *Controller) writeLoop(ctx context.Context, cancel context.CancelFunc, connection *websocket.Conn, outgoing <-chan []byte, done chan<- struct{}) {
	defer close(done)
	for data := range outgoing {
		writeCtx, writeCancel := context.WithTimeout(ctx, writeTimeout)
		err := connection.Write(writeCtx, websocket.MessageText, data)
		writeCancel()
		if err != nil {
			cancel()
			return
		}
	}
}

func (controller *Controller) writeError(ctx context.Context, connection *websocket.Conn, err error) {
	_ = writeEnvelope(ctx, connection, errorEnvelope(err, nil))
}

func (controller *Controller) sendError(connectionID string, err error, mutationID *string) {
	controller.hub.send(connectionID, errorEnvelope(err, mutationID))
}

func writeEnvelope(parent context.Context, connection *websocket.Conn, envelope protocol.Envelope) error {
	data, err := protocol.Encode(envelope)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, writeTimeout)
	defer cancel()
	return connection.Write(ctx, websocket.MessageText, data)
}

func errorEnvelope(err error, mutationID *string) *protocol.ErrorEnvelope {
	code := protocol.ErrorInternal
	message := "internal error"
	var codecError *protocol.CodecError
	var serviceError *scratchpad.Error
	switch {
	case errors.As(err, &codecError):
		code, message = codecError.Code, codecError.Msg
	case errors.As(err, &serviceError):
		applicationCode := scratchpad.ErrorCodeOf(serviceError)
		code, message = protocol.ErrorCode(applicationCode), scratchpad.PublicMessage(applicationCode)
	}
	return &protocol.ErrorEnvelope{V: protocol.Version, Type: "error", Code: code, Message: message, MutationID: mutationID}
}

func wireScratchpad(value scratchpad.Scratchpad) protocol.ScratchpadState {
	return protocol.ScratchpadState{ID: value.ID, Content: value.Content, Revision: value.Revision, UpdatedAt: value.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}

func wireConflict(value scratchpad.Conflict) *protocol.ConflictEnvelope {
	return &protocol.ConflictEnvelope{V: protocol.Version, Type: "conflict", ConflictRecord: protocol.ConflictRecord{
		ConflictID: value.ID, ScratchpadID: value.ScratchpadID, MutationID: value.MutationID,
		SubmittedContent: value.SubmittedContent, BaseRevision: value.BaseRevision,
		ServerContent: value.ServerContent, ServerRevision: value.ServerRevision,
		ClientID: value.ClientID, SessionID: value.SessionID, CreatedAt: value.CreatedAt.UTC().Format(time.RFC3339Nano),
	}}
}

func wireConflicts(values []scratchpad.Conflict) []protocol.ConflictRecord {
	result := make([]protocol.ConflictRecord, 0, len(values))
	for _, value := range values {
		result = append(result, wireConflict(value).ConflictRecord)
	}
	return result
}
